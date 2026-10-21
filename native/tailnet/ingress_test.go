//go:build !windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
)

func TestPreambleEncoding(t *testing.T) {
	who := &apitype.WhoIsResponse{
		Node: &tailcfg.Node{
			StableID: "nStable123",
			Name:     "phone.tailnet.ts.net.",
			User:     tailcfg.UserID(1<<60 + 1),
		},
		UserProfile: &tailcfg.UserProfile{LoginName: "khoi@github", DisplayName: "Khoi"},
	}
	p := preamble{
		V:      1,
		Secret: testSecret,
		TLS:    true,
		Peer:   peerFromWhoIs("100.64.0.7:51234", who),
		Self:   &selfIdentity{UserID: "1152921504606846977", Tagged: false},
	}
	got, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"v":1,"secret":"` + testSecret + `","tls":true,` +
		`"peer":{"ip":"100.64.0.7","nodeId":"nStable123","nodeName":"phone.tailnet.ts.net","userId":"1152921504606846977","loginName":"khoi@github","displayName":"Khoi","tagged":false,"tags":[]},` +
		`"self":{"userId":"1152921504606846977","tagged":false}}`
	if string(got) != want {
		t.Fatalf("preamble\n got: %s\nwant: %s", got, want)
	}

	who.Node.Tags = []string{"tag:server"}
	tagged := peerFromWhoIs("100.64.0.7:51234", who)
	if !tagged.Tagged || len(tagged.Tags) != 1 {
		t.Fatalf("tagged peer: %+v", tagged)
	}

	unknown, _ := json.Marshal(preamble{V: 1, Secret: testSecret, Peer: peerFromWhoIs("100.64.0.7:1", nil)})
	if !strings.Contains(string(unknown), `"peer":null`) || !strings.Contains(string(unknown), `"self":null`) {
		t.Fatalf("unknown peer must encode as null: %s", unknown)
	}
}

type fakeNode struct {
	t        *testing.T
	ln       net.Listener
	address  string
	preamble chan preamble
}

// startFakeNode plays the Node side of the ingress: it reads the preamble
// line, answers with verdict (or closes when verdict is negative), then runs
// after on the admitted socket.
func startFakeNode(t *testing.T, verdict int, after func(net.Conn)) *fakeNode {
	t.Helper()
	dir, err := os.MkdirTemp("", "tn")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	address := filepath.Join(dir, "i.sock")
	ln, err := net.Listen("unix", address)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	fn := &fakeNode{t: t, ln: ln, address: address, preamble: make(chan preamble, 1)}
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		if err != nil {
			return
		}
		var p preamble
		if json.Unmarshal(line, &p) == nil {
			fn.preamble <- p
		}
		if verdict < 0 {
			return
		}
		conn.Write([]byte{byte(verdict)})
		if after != nil {
			after(conn)
		}
	}()
	return fn
}

func testIngress(address string) *ingress {
	return &ingress{
		address: address,
		secret:  testSecret,
		whois: func(_ context.Context, addr string) (*apitype.WhoIsResponse, error) {
			if !strings.HasPrefix(addr, "127.0.0.1:") {
				return nil, errors.New("unexpected address " + addr)
			}
			return &apitype.WhoIsResponse{
				Node:        &tailcfg.Node{StableID: "nPeer", Name: "phone.ts.net.", User: 42},
				UserProfile: &tailcfg.UserProfile{LoginName: "khoi@github"},
			}, nil
		},
		self: func() *selfIdentity { return &selfIdentity{UserID: "42"} },
		logf: func(string, ...any) {},
	}
}

// tcpPair returns a client conn and the server conn the ingress handles, so
// the test exercises real half-close and buffering.
func tcpPair(t *testing.T) (client, server net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, _ := ln.Accept()
		accepted <- conn
	}()
	client, err = net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server = <-accepted
	t.Cleanup(func() { client.Close(); server.Close() })
	client.SetDeadline(time.Now().Add(10 * time.Second))
	return client, server
}

func TestIngressAcceptRelaysBothWays(t *testing.T) {
	fn := startFakeNode(t, 1, func(conn net.Conn) {
		buf := make([]byte, 4)
		if _, err := io.ReadFull(conn, buf); err != nil || string(buf) != "ping" {
			return
		}
		conn.Write([]byte("pong"))
	})
	client, server := tcpPair(t)
	done := make(chan struct{})
	go func() {
		testIngress(fn.address).serveConn(server)
		close(done)
	}()

	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(client)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "pong" {
		t.Fatalf("client read %q, want pong", got)
	}
	p := <-fn.preamble
	if p.V != 1 || p.Secret != testSecret || p.TLS || p.Peer == nil || p.Peer.UserID != "42" || p.Peer.NodeID != "nPeer" || p.Self == nil || p.Self.UserID != "42" {
		t.Fatalf("unexpected preamble: %+v peer=%+v", p, p.Peer)
	}
	client.Close()
	<-done
}

func TestIngressRejects(t *testing.T) {
	cases := map[string]int{"verdict 0": 0, "unknown verdict": 2, "closed without verdict": -1}
	for name, verdict := range cases {
		t.Run(name, func(t *testing.T) {
			fn := startFakeNode(t, verdict, nil)
			client, server := tcpPair(t)
			go testIngress(fn.address).serveConn(server)
			client.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n"))
			got, err := io.ReadAll(client)
			if err != nil {
				t.Fatal(err)
			}
			want := "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: 70\r\n\r\n" + forbiddenBody
			if string(got) != want {
				t.Fatalf("got %q\nwant %q", got, want)
			}
		})
	}
}

func TestIngressDialFailureIs502(t *testing.T) {
	client, server := tcpPair(t)
	go testIngress(filepath.Join(t.TempDir(), "missing.sock")).serveConn(server)
	got, err := io.ReadAll(client)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(got), "HTTP/1.1 502 Bad Gateway\r\n") || !strings.HasSuffix(string(got), unavailableBody) {
		t.Fatalf("got %q", got)
	}
}

func TestIngressWhoIsFailureSendsNullPeer(t *testing.T) {
	fn := startFakeNode(t, 0, nil)
	in := testIngress(fn.address)
	in.whois = func(context.Context, string) (*apitype.WhoIsResponse, error) { return nil, errors.New("no peer") }
	client, server := tcpPair(t)
	go in.serveConn(server)
	io.ReadAll(client)
	if p := <-fn.preamble; p.Peer != nil {
		t.Fatalf("peer = %+v, want nil", p.Peer)
	}
}

func TestExposureCloseCutsLiveConnections(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	accepted := make(chan struct{})
	e := expose(ln, func(c net.Conn) {
		close(accepted)
		io.Copy(io.Discard, c)
	})
	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	<-accepted
	e.close()
	client.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := client.Read(make([]byte, 1)); err == nil || errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("live connection survived close: %v", err)
	}
	if _, err := net.DialTimeout("tcp", ln.Addr().String(), time.Second); err == nil {
		t.Fatal("listener still accepting after close")
	}
}
