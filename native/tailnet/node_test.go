package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"math/big"
	"net/netip"
	"testing"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/views"
)

func runningStatus() *ipnstate.Status {
	tags := views.SliceOf([]string{"tag:supaterm"})
	expiry := time.Date(2027, 4, 19, 12, 0, 0, 0, time.FixedZone("x", 3600))
	return &ipnstate.Status{
		BackendState:   "Running",
		AuthURL:        "https://login.tailscale.com/a/stale",
		CertDomains:    []string{"host.tailnet.ts.net"},
		CurrentTailnet: &ipnstate.TailnetStatus{MagicDNSEnabled: true},
		Health:         []string{"z warning", "The local log is misconfigured: tailnet requires logging to be enabled. Remove --no-logs-no-support from tailscaled command line.", "a warning"},
		Self: &ipnstate.PeerStatus{
			InNetworkMap: true,
			DNSName:      "host.tailnet.ts.net.",
			UserID:       tailcfg.UserID(1<<62 + 3),
			Tags:         &tags,
			TailscaleIPs: []netip.Addr{netip.MustParseAddr("fd7a:115c:a1e0::1"), netip.MustParseAddr("100.101.102.103")},
			KeyExpiry:    &expiry,
		},
		User: map[tailcfg.UserID]tailcfg.UserProfile{
			tailcfg.UserID(1<<62 + 3): {LoginName: "tagged-devices", DisplayName: "Tagged Devices"},
		},
	}
}

func TestSelfFromStatus(t *testing.T) {
	self := selfFromStatus(runningStatus())
	want := selfInfo{
		DNSName:     "host.tailnet.ts.net",
		IPv4:        "100.101.102.103",
		IPv6:        "fd7a:115c:a1e0::1",
		UserID:      "4611686018427387907",
		LoginName:   "tagged-devices",
		DisplayName: "Tagged Devices",
		Tagged:      true,
		Tags:        []string{"tag:supaterm"},
		KeyExpiry:   "2027-04-19T11:00:00Z",
	}
	if self == nil || self.DNSName != want.DNSName || self.IPv4 != want.IPv4 || self.IPv6 != want.IPv6 ||
		self.UserID != want.UserID || self.LoginName != want.LoginName || self.DisplayName != want.DisplayName ||
		self.Tagged != want.Tagged || len(self.Tags) != 1 || self.KeyExpiry != want.KeyExpiry {
		t.Fatalf("self = %+v\nwant %+v", self, want)
	}
	if httpURL(self) != "http://100.101.102.103/" {
		t.Fatalf("httpURL = %q", httpURL(self))
	}

	st := runningStatus()
	st.Self.InNetworkMap = false
	if selfFromStatus(st) != nil {
		t.Fatal("self must be absent before the netmap has a self node")
	}
}

func TestBuildStatus(t *testing.T) {
	st := runningStatus()
	s := buildStatus(st, selfFromStatus(st), statusExtras{https: "ready", browseURL: "https://login.tailscale.com/a/bus"})
	if s.AuthURL != "" {
		t.Fatalf("authUrl must only be sent while NeedsLogin, got %q", s.AuthURL)
	}
	if !s.LoggingRequired {
		t.Fatal("logging-required health warning must set loggingRequired")
	}
	if len(s.Health) != 2 || s.Health[0] != "a warning" || s.Health[1] != "z warning" {
		t.Fatalf("health must be sorted without the logging warning: %q", s.Health)
	}

	st.BackendState = "NeedsLogin"
	if got := buildStatus(st, nil, statusExtras{}).AuthURL; got != "https://login.tailscale.com/a/stale" {
		t.Fatalf("authUrl = %q, want the status URL", got)
	}
	st.AuthURL = ""
	if got := buildStatus(st, nil, statusExtras{browseURL: "https://login.tailscale.com/a/bus"}).AuthURL; got != "https://login.tailscale.com/a/bus" {
		t.Fatalf("authUrl = %q, want the bus URL", got)
	}

	st.Health = nil
	rejected := buildStatus(st, nil, statusExtras{errMessage: "requested tags [tag:x] are invalid or not permitted"})
	if rejected.ErrMessage == "" || rejected.LoggingRequired || rejected.Health == nil {
		t.Fatalf("unexpected status: %+v", rejected)
	}
	logging := buildStatus(st, nil, statusExtras{errMessage: "tailnet requires logging to be enabled. Remove --no-logs-no-support from tailscaled command line."})
	if logging.ErrMessage != "" || !logging.LoggingRequired {
		t.Fatalf("logging-required error must map to loggingRequired: %+v", logging)
	}
}

func TestCertDomain(t *testing.T) {
	st := runningStatus()
	if d, ok := certDomain(st); d != "host.tailnet.ts.net" || !ok {
		t.Fatalf("certDomain = %q, %v", d, ok)
	}
	st.CurrentTailnet.MagicDNSEnabled = false
	if _, ok := certDomain(st); ok {
		t.Fatal("MagicDNS off must disable HTTPS")
	}
	st = runningStatus()
	st.CertDomains = nil
	if _, ok := certDomain(st); ok {
		t.Fatal("no cert domains must disable HTTPS")
	}
	st = runningStatus()
	st.Self.DNSName = "renamed.tailnet.ts.net."
	if d, ok := certDomain(st); d != "" || !ok {
		t.Fatalf("a name outside CertDomains must stay pending, got %q, %v", d, ok)
	}
}

func TestApplyCertBacksOff(t *testing.T) {
	n := &node{logf: func(string, ...any) {}, cert: certState{domain: "host.ts.net", inflight: true}}
	for _, want := range []time.Duration{time.Minute, 5 * time.Minute, 30 * time.Minute, 30 * time.Minute} {
		start := time.Now()
		n.cert.inflight = true
		n.applyCert(certResult{domain: "host.ts.net", err: errors.New("acme failed")})
		if got := n.cert.retryAt.Sub(start); got < want || got > want+time.Second {
			t.Fatalf("retry after %v, want %v", got, want)
		}
		if n.cert.inflight || n.cert.ready || n.cert.message != "acme failed" {
			t.Fatalf("unexpected state %+v", n.cert)
		}
	}
	n.applyCert(certResult{domain: "old.ts.net"})
	if n.cert.ready {
		t.Fatal("a result for another domain must be ignored")
	}
	n.applyCert(certResult{domain: "host.ts.net"})
	if !n.cert.ready || n.cert.failures != 0 || n.cert.message != "" {
		t.Fatalf("unexpected state %+v", n.cert)
	}
}

func TestCertCache(t *testing.T) {
	certPEM, keyPEM := selfSignedPair(t, time.Now().Add(48*time.Hour))
	fetches := 0
	var fail error
	c := &certCache{fetch: func(context.Context, string) ([]byte, []byte, error) {
		fetches++
		return certPEM, keyPEM, fail
	}}
	ctx := context.Background()
	first, err := c.get(ctx, "host.ts.net")
	if err != nil {
		t.Fatal(err)
	}
	if again, _ := c.get(ctx, "host.ts.net"); again != first || fetches != 1 {
		t.Fatalf("cached certificate not reused; fetches=%d", fetches)
	}

	c.refetch = time.Now().Add(-time.Second)
	fail = errors.New("localapi unavailable")
	if kept, err := c.get(ctx, "host.ts.net"); err != nil || kept != first {
		t.Fatalf("a valid certificate must survive a failed refetch: %v", err)
	}
	if _, err := c.get(ctx, "other.ts.net"); err == nil {
		t.Fatal("another domain must not reuse the cached certificate")
	}
}

func selfSignedPair(t *testing.T, notAfter time.Time) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"host.ts.net"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
}
