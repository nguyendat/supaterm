package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

var testSecret = strings.Repeat("0f", 32)

func configureLine(t *testing.T, mutate func(map[string]any)) []byte {
	t.Helper()
	m := map[string]any{
		"v":        1,
		"type":     "configure",
		"dir":      "/state/tailnet/tailscale",
		"hostname": "khoi-abc-supaterm",
		"tags":     []string{"tag:x"},
		"serve":    true,
		"ingress":  map[string]any{"address": "/tmp/i.sock", "secret": testSecret},
		"authKey":  "tskey-auth-secret",
	}
	if mutate != nil {
		mutate(m)
	}
	line, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return line
}

func TestParseConfigure(t *testing.T) {
	c, err := parseConfigure(configureLine(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Hostname != "khoi-abc-supaterm" || !c.Serve || c.Ingress.Secret != testSecret || c.AuthKey != "tskey-auth-secret" || len(c.Tags) != 1 {
		t.Fatalf("unexpected configure: %+v", c)
	}
}

func TestParseConfigureRejects(t *testing.T) {
	cases := map[string]func(map[string]any){
		"version":      func(m map[string]any) { m["v"] = 2 },
		"type":         func(m map[string]any) { m["type"] = "login" },
		"relative dir": func(m map[string]any) { m["dir"] = "state/tailscale" },
		"basename":     func(m map[string]any) { m["dir"] = "/state/tailnet/node" },
		"hostname":     func(m map[string]any) { delete(m, "hostname") },
		"address":      func(m map[string]any) { m["ingress"] = map[string]any{"secret": testSecret} },
		"short secret": func(m map[string]any) { m["ingress"] = map[string]any{"address": "/tmp/i.sock", "secret": "abcd"} },
		"non-hex secret": func(m map[string]any) {
			m["ingress"] = map[string]any{"address": "/tmp/i.sock", "secret": strings.Repeat("zz", 32)}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := parseConfigure(configureLine(t, mutate))
			if err == nil {
				t.Fatal("expected an error")
			}
			if strings.Contains(err.Error(), testSecret) || strings.Contains(err.Error(), "tskey") {
				t.Fatalf("error leaks a secret: %v", err)
			}
		})
	}
}

func TestParseCommandDoesNotEchoInput(t *testing.T) {
	_, err := parseCommand([]byte(`{"v":1,"type":"configure","authKey":"tskey-auth-secret",`))
	if err == nil || strings.Contains(err.Error(), "tskey") {
		t.Fatalf("got %v", err)
	}
}

func TestSendStatusDedupes(t *testing.T) {
	var buf bytes.Buffer
	out := &emitter{w: &buf}
	running := statusMsg{header: newHeader("status"), BackendState: "Running", HTTPS: "pending", Health: []string{}}
	out.sendStatus(running)
	out.sendStatus(running)
	ready := running
	ready.HTTPS = "ready"
	out.sendStatus(ready)
	out.sendStatus(running)

	lines := strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("got %d lines, want 3:\n%s", len(lines), buf.String())
	}
	var first map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	if first["v"] != float64(1) || first["type"] != "status" || first["backendState"] != "Running" {
		t.Fatalf("unexpected status line: %s", lines[0])
	}
	if _, ok := first["authUrl"]; ok {
		t.Fatalf("empty authUrl must be omitted: %s", lines[0])
	}
}
