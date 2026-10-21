package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/types/logger"
)

const (
	handshakeTimeout = 10 * time.Second
	whoisTimeout     = 5 * time.Second
	dialTimeout      = 5 * time.Second
	verdictTimeout   = 10 * time.Second
	rejectTimeout    = 5 * time.Second
	halfCloseGrace   = 30 * time.Second

	forbiddenResponse   = "403 Forbidden"
	forbiddenBody       = "This Supaterm environment only accepts its owner's Tailscale account.\n"
	unavailableResponse = "502 Bad Gateway"
	unavailableBody     = "This Supaterm environment is not accepting connections right now.\n"
)

type preamble struct {
	V      int           `json:"v"`
	Secret string        `json:"secret"`
	TLS    bool          `json:"tls"`
	Peer   *peerInfo     `json:"peer"`
	Self   *selfIdentity `json:"self"`
}

type peerInfo struct {
	IP          string   `json:"ip"`
	NodeID      string   `json:"nodeId"`
	NodeName    string   `json:"nodeName"`
	UserID      string   `json:"userId"`
	LoginName   string   `json:"loginName"`
	DisplayName string   `json:"displayName"`
	Tagged      bool     `json:"tagged"`
	Tags        []string `json:"tags"`
}

type selfIdentity struct {
	UserID string `json:"userId"`
	Tagged bool   `json:"tagged"`
}

type ingress struct {
	address string
	secret  string
	whois   func(ctx context.Context, remoteAddr string) (*apitype.WhoIsResponse, error)
	self    func() *selfIdentity
	logf    logger.Logf
}

// serveConn admits one tailnet connection: Node sees the caller's identity
// before any client byte, and only an explicit 0x01 verdict opens the relay.
func (in *ingress) serveConn(client net.Conn) {
	defer client.Close()
	tlsConn, isTLS := client.(*tls.Conn)
	if isTLS {
		ctx, cancel := context.WithTimeout(context.Background(), handshakeTimeout)
		err := tlsConn.HandshakeContext(ctx)
		cancel()
		if err != nil {
			return
		}
	}
	peer := in.lookup(client.RemoteAddr().String())

	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	upstream, err := dialIngress(ctx, in.address)
	cancel()
	if err != nil {
		in.logf("ingress: dial failed: %v", err)
		reject(client, unavailableResponse, unavailableBody)
		return
	}
	defer upstream.Close()

	if !admit(upstream, preamble{V: protocolVersion, Secret: in.secret, TLS: isTLS, Peer: peer, Self: in.self()}) {
		reject(client, forbiddenResponse, forbiddenBody)
		return
	}
	relay(client, upstream)
}

func (in *ingress) lookup(remoteAddr string) *peerInfo {
	ctx, cancel := context.WithTimeout(context.Background(), whoisTimeout)
	defer cancel()
	who, err := in.whois(ctx, remoteAddr)
	if err != nil {
		in.logf("ingress: whois failed: %v", err)
		return nil
	}
	return peerFromWhoIs(remoteAddr, who)
}

func peerFromWhoIs(remoteAddr string, who *apitype.WhoIsResponse) *peerInfo {
	if who == nil || who.Node == nil {
		return nil
	}
	node := who.Node
	peer := &peerInfo{
		IP:       remoteIP(remoteAddr),
		NodeID:   string(node.StableID),
		NodeName: strings.TrimSuffix(node.Name, "."),
		UserID:   strconv.FormatInt(int64(node.User), 10),
		Tagged:   node.IsTagged(),
		Tags:     append([]string{}, node.Tags...),
	}
	if who.UserProfile != nil {
		peer.LoginName = who.UserProfile.LoginName
		peer.DisplayName = who.UserProfile.DisplayName
	}
	return peer
}

func remoteIP(remoteAddr string) string {
	if ap, err := netip.ParseAddrPort(remoteAddr); err == nil {
		return ap.Addr().Unmap().String()
	}
	return remoteAddr
}

func admit(upstream net.Conn, p preamble) bool {
	line, err := json.Marshal(p)
	if err != nil {
		return false
	}
	upstream.SetDeadline(time.Now().Add(verdictTimeout))
	if _, err := upstream.Write(append(line, '\n')); err != nil {
		return false
	}
	var verdict [1]byte
	if _, err := io.ReadFull(upstream, verdict[:]); err != nil || verdict[0] != 1 {
		return false
	}
	upstream.SetDeadline(time.Time{})
	return true
}

// reject half-closes and drains before closing so the client reads the
// response instead of a reset caused by its unread request bytes.
func reject(client net.Conn, status, body string) {
	client.SetDeadline(time.Now().Add(rejectTimeout))
	_, err := fmt.Fprintf(client, "HTTP/1.1 %s\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: %d\r\n\r\n%s", status, len(body), body)
	if err != nil {
		return
	}
	if closeWrite(client) {
		client.SetReadDeadline(time.Now().Add(time.Second))
		io.Copy(io.Discard, io.LimitReader(client, 64<<10))
	}
}

func closeWrite(conn net.Conn) bool {
	cw, ok := conn.(interface{ CloseWrite() error })
	return ok && cw.CloseWrite() == nil
}

// relay copies both directions. Once one side finishes, the other gets a grace
// period so a peer that never closes its half cannot pin the connection.
func relay(client, upstream net.Conn) {
	done := make(chan struct{}, 2)
	go func() { pump(upstream, client); done <- struct{}{} }()
	go func() { pump(client, upstream); done <- struct{}{} }()
	<-done
	deadline := time.Now().Add(halfCloseGrace)
	client.SetReadDeadline(deadline)
	upstream.SetReadDeadline(deadline)
	<-done
}

func pump(dst, src net.Conn) {
	_, err := io.Copy(dst, src)
	if err == nil && closeWrite(dst) {
		return
	}
	dst.Close()
	src.Close()
}

// exposure is one open tailnet listener plus the connections it accepted, so
// withdrawing it also cuts live traffic instead of leaving it to Node.
type exposure struct {
	ln    net.Listener
	mu    sync.Mutex
	conns map[net.Conn]struct{}
}

func expose(ln net.Listener, handle func(net.Conn)) *exposure {
	e := &exposure{ln: ln, conns: map[net.Conn]struct{}{}}
	go e.accept(handle)
	return e
}

func (e *exposure) accept(handle func(net.Conn)) {
	for {
		conn, err := e.ln.Accept()
		if err != nil {
			return
		}
		if !e.track(conn) {
			conn.Close()
			return
		}
		go func() {
			defer e.untrack(conn)
			handle(conn)
		}()
	}
}

func (e *exposure) track(conn net.Conn) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.conns == nil {
		return false
	}
	e.conns[conn] = struct{}{}
	return true
}

func (e *exposure) untrack(conn net.Conn) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.conns, conn)
}

func (e *exposure) close() {
	e.ln.Close()
	e.mu.Lock()
	conns := e.conns
	e.conns = nil
	e.mu.Unlock()
	for conn := range conns {
		conn.Close()
	}
}
