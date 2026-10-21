package main

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

func TestStderrLogfRedactsAndDropsVerbose(t *testing.T) {
	var buf bytes.Buffer
	logf := stderrLogf(&buf)
	logf("AuthURL is %v", "https://login.tailscale.com/a/1a2b3c4d5e6f")
	logf("RegisterReq: got response; authURL=%v", "https://login.tailscale.com/a/abc")
	logf("using key %s", "tskey-auth-kAbc123-XYZ")
	logf("[v1] netmap diff: %s", "noise")
	logf("magicsock: [v2] %s", "noise")
	logf("plain line\n")

	got := buf.String()
	for _, leak := range []string{"/a/1a2b", "/a/abc", "tskey-auth", "noise"} {
		if strings.Contains(got, leak) {
			t.Fatalf("stderr leaked %q:\n%s", leak, got)
		}
	}
	want := "AuthURL is [redacted]\nRegisterReq: got response; authURL=[redacted]\nusing key [redacted]\nplain line\n"
	if got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

func TestScrubEnv(t *testing.T) {
	t.Setenv("TS_AUTHKEY", "tskey-auth-x")
	t.Setenv("TSNET_FORCE_LOGIN", "1")
	t.Setenv("HTTPS_PROXY", "http://proxy:3128")
	scrubEnv()
	if _, ok := os.LookupEnv("TS_AUTHKEY"); ok {
		t.Fatal("TS_AUTHKEY survived")
	}
	if _, ok := os.LookupEnv("TSNET_FORCE_LOGIN"); ok {
		t.Fatal("TSNET_FORCE_LOGIN survived")
	}
	if os.Getenv("HTTPS_PROXY") == "" {
		t.Fatal("proxy variables must be kept")
	}
}
