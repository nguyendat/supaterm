package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"sync"
)

const protocolVersion = 1

type command struct {
	V            int           `json:"v"`
	Type         string        `json:"type"`
	Dir          string        `json:"dir"`
	Hostname     string        `json:"hostname"`
	Tags         []string      `json:"tags"`
	Serve        bool          `json:"serve"`
	Enabled      bool          `json:"enabled"`
	AllowLogging bool          `json:"allowLogging"`
	Ingress      ingressConfig `json:"ingress"`
	AuthKey      string        `json:"authKey"`
}

type ingressConfig struct {
	Address string `json:"address"`
	Secret  string `json:"secret"`
}

// Errors never echo the input line: it carries the ingress secret and auth key.
func parseCommand(line []byte) (command, error) {
	var c command
	if err := json.Unmarshal(line, &c); err != nil {
		return command{}, errors.New("command is not a JSON object")
	}
	if c.V != protocolVersion {
		return command{}, fmt.Errorf("unsupported protocol version %d", c.V)
	}
	return c, nil
}

func parseConfigure(line []byte) (command, error) {
	c, err := parseCommand(line)
	if err != nil {
		return command{}, err
	}
	secret, _ := hex.DecodeString(c.Ingress.Secret)
	switch {
	case c.Type != "configure":
		return command{}, fmt.Errorf("first command must be configure, got %q", c.Type)
	case !filepath.IsAbs(c.Dir) || filepath.Base(c.Dir) != "tailscale":
		return command{}, errors.New("dir must be an absolute path named tailscale")
	case c.Hostname == "":
		return command{}, errors.New("hostname is required")
	case c.Ingress.Address == "":
		return command{}, errors.New("ingress.address is required")
	case len(secret) != 32:
		return command{}, errors.New("ingress.secret must be 64 hex characters")
	}
	return c, nil
}

type header struct {
	V    int    `json:"v"`
	Type string `json:"type"`
}

func newHeader(typ string) header { return header{V: protocolVersion, Type: typ} }

type helloMsg struct {
	header
	Version          string `json:"version"`
	TailscaleVersion string `json:"tailscaleVersion"`
}

type statusMsg struct {
	header
	BackendState    string    `json:"backendState"`
	AuthURL         string    `json:"authUrl,omitempty"`
	ErrMessage      string    `json:"errMessage,omitempty"`
	Self            *selfInfo `json:"self,omitempty"`
	HTTPS           string    `json:"https"`
	HTTPSMessage    string    `json:"httpsMessage,omitempty"`
	Listening       listening `json:"listening"`
	LoggingRequired bool      `json:"loggingRequired"`
	Health          []string  `json:"health"`
}

type selfInfo struct {
	DNSName     string   `json:"dnsName"`
	IPv4        string   `json:"ipv4,omitempty"`
	IPv6        string   `json:"ipv6,omitempty"`
	UserID      string   `json:"userId"`
	LoginName   string   `json:"loginName"`
	DisplayName string   `json:"displayName"`
	Tagged      bool     `json:"tagged"`
	Tags        []string `json:"tags"`
	KeyExpiry   string   `json:"keyExpiry,omitempty"`
}

type listening struct {
	HTTPS string `json:"https,omitempty"`
	HTTP  string `json:"http,omitempty"`
}

type loggedOutMsg struct {
	header
	Confirmed bool   `json:"confirmed"`
	Message   string `json:"message,omitempty"`
}

type errorMsg struct {
	header
	Code    string `json:"code"`
	Message string `json:"message"`
	Fatal   bool   `json:"fatal"`
}

type emitter struct {
	mu         sync.Mutex
	w          io.Writer
	lastStatus []byte
}

func (e *emitter) send(msg any) {
	line, err := json.Marshal(msg)
	if err != nil {
		panic(err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.write(line)
}

func (e *emitter) sendStatus(s statusMsg) {
	line, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if bytes.Equal(line, e.lastStatus) {
		return
	}
	e.lastStatus = line
	e.write(line)
}

func (e *emitter) write(line []byte) {
	e.w.Write(append(line, '\n'))
}

func (e *emitter) error(code string, err error, fatal bool) {
	e.send(errorMsg{header: newHeader("error"), Code: code, Message: err.Error(), Fatal: fatal})
}
