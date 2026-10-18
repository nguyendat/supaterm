package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
)

type fakeWhoIsClient struct {
	response *apitype.WhoIsResponse
}

func (f fakeWhoIsClient) WhoIs(context.Context, string) (*apitype.WhoIsResponse, error) {
	return f.response, nil
}

func TestNormalizeHostname(t *testing.T) {
	tests := map[string]string{
		"Khoi-Mac":         "khoi-mac-supaterm",
		"already-supaterm": "already-supaterm",
		"  weird name  ":   "weird-name-supaterm",
		"!!!":              "supaterm-supaterm",
	}
	for input, expected := range tests {
		if actual := normalizeHostname(input); actual != expected {
			t.Errorf("normalizeHostname(%q) = %q, want %q", input, actual, expected)
		}
	}
	longHostname := normalizeHostname(strings.Repeat("a", 100))
	if len(longHostname) > 63 || !strings.HasSuffix(longHostname, "-supaterm") {
		t.Fatalf("long hostname = %q, want a <=63-character -supaterm hostname", longHostname)
	}
}

func TestProxyHandlerRequiresTheOwningAccount(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	targetURL, err := url.Parse(target.URL)
	if err != nil {
		t.Fatal(err)
	}

	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	handler := &proxyHandler{
		proxy: proxy,
		local: &tailscaleClient{client: fakeWhoIsClient{response: &apitype.WhoIsResponse{
			UserProfile: &tailcfg.UserProfile{LoginName: "khoi@example.com"},
		}}},
		owner:      "khoi@example.com",
		ownerReady: true,
	}

	allowed := httptest.NewRecorder()
	handler.ServeHTTP(allowed, httptest.NewRequest(http.MethodGet, "https://supaterm.example/", nil))
	if allowed.Code != http.StatusNoContent {
		t.Fatalf("matching account status = %d, want %d", allowed.Code, http.StatusNoContent)
	}

	handler.owner = "other@example.com"
	denied := httptest.NewRecorder()
	handler.ServeHTTP(denied, httptest.NewRequest(http.MethodGet, "https://supaterm.example/", nil))
	if denied.Code != http.StatusForbidden {
		t.Fatalf("non-matching account status = %d, want %d", denied.Code, http.StatusForbidden)
	}
}
