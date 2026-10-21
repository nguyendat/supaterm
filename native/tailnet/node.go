package main

import (
	"cmp"
	"context"
	"crypto/tls"
	"errors"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
)

const (
	statusTimeout  = 10 * time.Second
	commandTimeout = 30 * time.Second
	logoutTimeout  = 15 * time.Second
	prewarmTimeout = 2 * time.Minute
	recheckEvery   = time.Minute

	loggingRequiredText = "tailnet requires logging"
	busFellBehindText   = "IPN bus consumer fell behind"
)

var certBackoff = []time.Duration{time.Minute, 5 * time.Minute, 30 * time.Minute}

type node struct {
	srv     *tsnet.Server
	lc      *local.Client
	out     *emitter
	logf    logger.Logf
	ingress *ingress
	tls     *tls.Config
	certs   *certCache

	kick     chan struct{}
	certDone chan certResult
	snap     atomic.Pointer[snapshot]

	bus struct {
		sync.Mutex
		errMessage string
		browseURL  string
	}

	serve      bool
	cert       certState
	http       *exposure
	https      *exposure
	listenErrs map[string]string
}

// snapshot is what connection goroutines read without touching actor state.
type snapshot struct {
	self   *selfIdentity
	domain string
}

type certState struct {
	domain   string
	ready    bool
	inflight bool
	failures int
	retryAt  time.Time
	message  string
}

type certResult struct {
	domain string
	err    error
}

func newNode(srv *tsnet.Server, lc *local.Client, cfg command, out *emitter, logf logger.Logf) *node {
	n := &node{
		srv:        srv,
		lc:         lc,
		out:        out,
		logf:       logf,
		certs:      &certCache{fetch: lc.CertPair},
		kick:       make(chan struct{}, 1),
		certDone:   make(chan certResult),
		serve:      cfg.Serve,
		listenErrs: map[string]string{},
	}
	n.ingress = &ingress{
		address: cfg.Ingress.Address,
		secret:  cfg.Ingress.Secret,
		whois:   lc.WhoIs,
		self:    func() *selfIdentity { return n.snap.Load().self },
		logf:    logf,
	}
	n.tls = &tls.Config{
		NextProtos: []string{"http/1.1"},
		GetCertificate: func(hi *tls.ClientHelloInfo) (*tls.Certificate, error) {
			domain := n.snap.Load().domain
			if domain == "" {
				return nil, errors.New("no certificate domain")
			}
			return n.certs.get(hi.Context(), domain)
		},
	}
	n.snap.Store(&snapshot{})
	return n
}

// run owns all node state on one goroutine; it returns after shutdown or logout.
func (n *node) run(ctx context.Context, cmds <-chan command) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go n.watch(ctx)
	ticker := time.NewTicker(recheckEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			n.withdraw()
			return
		case c, ok := <-cmds:
			if !ok {
				c = command{Type: "shutdown"}
			}
			if n.handle(ctx, c) {
				return
			}
		case r := <-n.certDone:
			n.applyCert(r)
		case <-n.kick:
		case <-ticker.C:
		}
		n.reconcile(ctx)
	}
}

func (n *node) handle(ctx context.Context, c command) (done bool) {
	switch c.Type {
	case "login":
		n.bus.Lock()
		n.bus.errMessage = ""
		n.bus.Unlock()
		cctx, cancel := context.WithTimeout(ctx, commandTimeout)
		defer cancel()
		if err := n.lc.StartLoginInteractive(cctx); err != nil {
			n.out.error("login", err, false)
		}
	case "setServe":
		n.serve = c.Enabled
	case "setHostname":
		if c.Hostname == "" {
			n.out.error("protocol", errors.New("setHostname requires hostname"), false)
			return false
		}
		cctx, cancel := context.WithTimeout(ctx, commandTimeout)
		defer cancel()
		prefs := &ipn.MaskedPrefs{Prefs: ipn.Prefs{Hostname: c.Hostname}, HostnameSet: true}
		if _, err := n.lc.EditPrefs(cctx, prefs); err != nil {
			n.out.error("set-hostname", err, false)
		}
	case "logout":
		n.withdraw()
		cctx, cancel := context.WithTimeout(ctx, logoutTimeout)
		defer cancel()
		msg := loggedOutMsg{header: newHeader("loggedOut"), Confirmed: true}
		if err := n.lc.Logout(cctx); err != nil {
			msg.Confirmed, msg.Message = false, err.Error()
		}
		n.out.send(msg)
		return true
	case "shutdown":
		n.withdraw()
		return true
	default:
		n.out.error("protocol", errors.New("unexpected command "+strconv.Quote(c.Type)), false)
	}
	return false
}

func (n *node) watch(ctx context.Context) {
	for ctx.Err() == nil {
		err := n.watchOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		n.logf("ipn bus: %v; rewatching", err)
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
	}
}

func (n *node) watchOnce(ctx context.Context) error {
	w, err := n.lc.WatchIPNBus(ctx, ipn.NotifyInitialState|ipn.NotifyInitialHealthState)
	if err != nil {
		return err
	}
	defer w.Close()
	for {
		note, err := w.Next()
		if err != nil {
			return err
		}
		n.observe(note)
	}
}

func (n *node) observe(note ipn.Notify) {
	n.bus.Lock()
	if s := note.State; s != nil && *s != ipn.NeedsLogin {
		n.bus.browseURL = ""
		if *s == ipn.Running {
			n.bus.errMessage = ""
		}
	}
	if m := note.ErrMessage; m != nil && !strings.HasPrefix(*m, busFellBehindText) {
		n.bus.errMessage = *m
	}
	if u := note.BrowseToURL; u != nil {
		n.bus.browseURL = *u
	}
	n.bus.Unlock()
	select {
	case n.kick <- struct{}{}:
	default:
	}
}

func (n *node) reconcile(ctx context.Context) {
	sctx, cancel := context.WithTimeout(ctx, statusTimeout)
	st, err := n.lc.StatusWithoutPeers(sctx)
	cancel()
	if err != nil {
		if ctx.Err() == nil {
			n.logf("status: %v", err)
		}
		return
	}
	running := st.BackendState == ipn.Running.String()
	self := selfFromStatus(st)
	https, httpsMessage := n.evaluateHTTPS(ctx, st, running)
	snap := &snapshot{domain: n.cert.domain}
	if self != nil {
		snap.self = &selfIdentity{UserID: self.UserID, Tagged: self.Tagged}
	}
	n.snap.Store(snap)

	n.http = n.setExposure(n.http, n.serve && running, ":80", nil)
	n.https = n.setExposure(n.https, n.serve && running && https == "ready", ":443", n.tls)
	var open listening
	if n.http != nil && self != nil {
		open.HTTP = httpURL(self)
	}
	if n.https != nil {
		open.HTTPS = "https://" + n.cert.domain + "/"
	}

	n.bus.Lock()
	extras := statusExtras{
		errMessage:   n.bus.errMessage,
		browseURL:    n.bus.browseURL,
		https:        https,
		httpsMessage: httpsMessage,
		listening:    open,
	}
	n.bus.Unlock()
	n.out.sendStatus(buildStatus(st, self, extras))
}

func (n *node) evaluateHTTPS(ctx context.Context, st *ipnstate.Status, running bool) (state, message string) {
	if !running {
		return "pending", ""
	}
	domain, available := certDomain(st)
	if !available {
		return "disabled", ""
	}
	if n.cert.domain != domain {
		n.cert = certState{domain: domain}
	}
	if domain == "" {
		return "pending", ""
	}
	if n.cert.ready {
		return "ready", ""
	}
	if !n.cert.inflight && !time.Now().Before(n.cert.retryAt) {
		n.cert.inflight = true
		go n.prewarm(ctx, domain)
	}
	return "pending", n.cert.message
}

func (n *node) prewarm(ctx context.Context, domain string) {
	pctx, cancel := context.WithTimeout(ctx, prewarmTimeout)
	_, err := n.certs.get(pctx, domain)
	cancel()
	select {
	case n.certDone <- certResult{domain: domain, err: err}:
	case <-ctx.Done():
	}
}

func (n *node) applyCert(r certResult) {
	if r.domain != n.cert.domain {
		return
	}
	n.cert.inflight = false
	if r.err == nil {
		n.cert.ready, n.cert.failures, n.cert.message = true, 0, ""
		return
	}
	delay := certBackoff[min(n.cert.failures, len(certBackoff)-1)]
	n.cert.failures++
	n.cert.message = r.err.Error()
	if wait, limited := local.RateLimitRetryAfter(r.err); limited {
		delay = max(delay, wait)
		n.cert.message = "rate limited until " + time.Now().Add(delay).UTC().Format(time.RFC3339)
	}
	n.cert.retryAt = time.Now().Add(delay)
	n.logf("certificate for %s not ready: %v", r.domain, r.err)
}

func (n *node) setExposure(current *exposure, want bool, addr string, tlsConfig *tls.Config) *exposure {
	if !want {
		if current != nil {
			current.close()
		}
		return nil
	}
	if current != nil {
		return current
	}
	ln, err := n.srv.Listen("tcp", addr)
	if err != nil {
		if msg := err.Error(); n.listenErrs[addr] != msg {
			n.listenErrs[addr] = msg
			n.out.error("listen", err, false)
		}
		return nil
	}
	delete(n.listenErrs, addr)
	if tlsConfig != nil {
		ln = tls.NewListener(ln, tlsConfig)
	}
	return expose(ln, n.ingress.serveConn)
}

func (n *node) withdraw() {
	n.http = n.setExposure(n.http, false, ":80", nil)
	n.https = n.setExposure(n.https, false, ":443", nil)
}

type statusExtras struct {
	errMessage   string
	browseURL    string
	https        string
	httpsMessage string
	listening    listening
}

func buildStatus(st *ipnstate.Status, self *selfInfo, x statusExtras) statusMsg {
	s := statusMsg{
		header:       newHeader("status"),
		BackendState: st.BackendState,
		Self:         self,
		HTTPS:        x.https,
		HTTPSMessage: x.httpsMessage,
		Listening:    x.listening,
		Health:       []string{},
	}
	// The backend's logging-required text tells users to edit a tailscaled
	// command line they don't have; loggingRequired replaces it.
	for _, h := range st.Health {
		if strings.Contains(h, loggingRequiredText) {
			s.LoggingRequired = true
			continue
		}
		s.Health = append(s.Health, h)
	}
	slices.Sort(s.Health)
	if strings.Contains(x.errMessage, loggingRequiredText) {
		s.LoggingRequired = true
	} else {
		s.ErrMessage = x.errMessage
	}
	if st.BackendState == ipn.NeedsLogin.String() {
		s.AuthURL = cmp.Or(st.AuthURL, x.browseURL)
	}
	return s
}

func selfFromStatus(st *ipnstate.Status) *selfInfo {
	ps := st.Self
	if ps == nil || !ps.InNetworkMap {
		return nil
	}
	self := &selfInfo{
		DNSName: strings.TrimSuffix(ps.DNSName, "."),
		UserID:  strconv.FormatInt(int64(ps.UserID), 10),
		Tags:    []string{},
	}
	if ps.Tags != nil {
		self.Tags = append(self.Tags, ps.Tags.AsSlice()...)
	}
	self.Tagged = len(self.Tags) > 0
	for _, ip := range ps.TailscaleIPs {
		switch {
		case ip.Is4() && self.IPv4 == "":
			self.IPv4 = ip.String()
		case ip.Is6() && self.IPv6 == "":
			self.IPv6 = ip.String()
		}
	}
	if profile, ok := st.User[ps.UserID]; ok {
		self.LoginName, self.DisplayName = profile.LoginName, profile.DisplayName
	}
	if ps.KeyExpiry != nil {
		self.KeyExpiry = ps.KeyExpiry.UTC().Format(time.RFC3339)
	}
	return self
}

// certDomain reports the MagicDNS name a certificate can be issued for.
// available is false when the tailnet has HTTPS certificates or MagicDNS off.
func certDomain(st *ipnstate.Status) (domain string, available bool) {
	if len(st.CertDomains) == 0 || st.CurrentTailnet == nil || !st.CurrentTailnet.MagicDNSEnabled {
		return "", false
	}
	if st.Self == nil {
		return "", true
	}
	name := strings.TrimSuffix(st.Self.DNSName, ".")
	matchesName := func(d string) bool { return strings.EqualFold(d, name) }
	if name == "" || !slices.ContainsFunc(st.CertDomains, matchesName) {
		return "", true
	}
	return name, true
}

// httpURL uses the IP rather than the MagicDNS name: browsers' HTTPS-First
// mode warns on the name but treats the CGNAT range as private.
func httpURL(self *selfInfo) string {
	switch {
	case self.IPv4 != "":
		return "http://" + self.IPv4 + "/"
	case self.IPv6 != "":
		return "http://[" + self.IPv6 + "]/"
	}
	return ""
}

// certCache keeps the parsed pair so handshakes skip LocalAPI and PEM parsing;
// the hourly refetch lets tailscaled's own renewal take effect.
type certCache struct {
	fetch func(ctx context.Context, domain string) (certPEM, keyPEM []byte, err error)

	mu      sync.Mutex
	domain  string
	cert    *tls.Certificate
	refetch time.Time
}

func (c *certCache) get(ctx context.Context, domain string) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	current := c.cert != nil && c.domain == domain
	if current && now.Before(c.refetch) {
		return c.cert, nil
	}
	cert, err := c.load(ctx, domain)
	if err != nil {
		if current && now.Before(c.cert.Leaf.NotAfter) {
			return c.cert, nil
		}
		return nil, err
	}
	c.domain, c.cert = domain, cert
	c.refetch = now.Add(time.Hour)
	if cert.Leaf.NotAfter.Before(c.refetch) {
		c.refetch = cert.Leaf.NotAfter
	}
	return cert, nil
}

func (c *certCache) load(ctx context.Context, domain string) (*tls.Certificate, error) {
	certPEM, keyPEM, err := c.fetch(ctx, domain)
	if err != nil {
		return nil, err
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, err
	}
	return &cert, nil
}
