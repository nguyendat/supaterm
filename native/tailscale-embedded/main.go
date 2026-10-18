package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

type command struct {
	Type    string `json:"type"`
	Enabled *bool  `json:"enabled,omitempty"`
}

type event struct {
	Type           string   `json:"type"`
	State          string   `json:"state,omitempty"`
	AuthURL        string   `json:"authUrl,omitempty"`
	Hostname       string   `json:"hostname,omitempty"`
	DNSName        string   `json:"dnsName,omitempty"`
	URL            string   `json:"url,omitempty"`
	OwnerLoginName string   `json:"ownerLoginName,omitempty"`
	TailscaleIPs   []string `json:"tailscaleIps,omitempty"`
	Enabled        *bool    `json:"enabled,omitempty"`
	Message        string   `json:"message,omitempty"`
}

type proxyHandler struct {
	mu         sync.RWMutex
	proxy      *httputil.ReverseProxy
	local      *tailscaleClient
	owner      string
	ownerReady bool
}

type tailscaleClient struct {
	client interface {
		WhoIs(context.Context, string) (*apitype.WhoIsResponse, error)
	}
}

func (h *proxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	ownerReady := h.ownerReady
	owner := h.owner
	h.mu.RUnlock()
	if !ownerReady || owner == "" {
		http.Error(w, "Tailscale identity is not ready", http.StatusServiceUnavailable)
		return
	}

	who, err := h.local.client.WhoIs(r.Context(), r.RemoteAddr)
	if err != nil || who == nil || who.UserProfile == nil || who.UserProfile.LoginName != owner {
		http.Error(w, "This Supaterm node is restricted to its Tailscale account", http.StatusForbidden)
		return
	}

	h.proxy.ServeHTTP(w, r)
}

func emit(mu *sync.Mutex, value event) {
	mu.Lock()
	defer mu.Unlock()
	data, err := json.Marshal(value)
	if err != nil {
		return
	}
	fmt.Println(string(data))
}

func normalizeHostname(value string) string {
	const suffix = "-supaterm"
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimSuffix(value, ".")
	if value == "" {
		value = "supaterm"
	}
	var builder strings.Builder
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-' {
			builder.WriteRune(char)
		} else {
			builder.WriteRune('-')
		}
	}
	value = strings.Trim(builder.String(), "-")
	if value == "" {
		value = "supaterm"
	}
	if strings.HasSuffix(value, suffix) {
		base := value[:len(value)-len(suffix)]
		base = strings.TrimRight(base[:min(len(base), 63-len(suffix))], "-")
		if base == "" {
			base = "supaterm"
		}
		return base + suffix
	}
	base := strings.TrimRight(value[:min(len(value), 63-len(suffix))], "-")
	if base == "" {
		base = "supaterm"
	}
	return base + suffix
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func magicDNSName(status *ipnstate.Status) string {
	if status == nil || status.Self == nil {
		return ""
	}
	return strings.TrimSuffix(status.Self.DNSName, ".")
}

func statusOwner(status *ipnstate.Status) string {
	if status == nil || status.Self == nil || status.User == nil {
		return ""
	}
	return status.User[status.Self.UserID].LoginName
}

func statusIPs(status *ipnstate.Status) []string {
	if status == nil {
		return nil
	}
	values := make([]string, 0, len(status.TailscaleIPs))
	for _, ip := range status.TailscaleIPs {
		values = append(values, ip.String())
	}
	return values
}

func run() error {
	hostnameFlag := flag.String("hostname", "supaterm", "hostname for the embedded Tailscale node")
	stateDirFlag := flag.String("state-dir", "", "persistent tsnet state directory")
	backendURLFlag := flag.String("backend-url", "", "loopback Supaterm backend URL")
	tagsFlag := flag.String("tags", "", "comma-separated Tailscale tags")
	serveFlag := flag.Bool("serve", true, "serve the backend over HTTPS")
	flag.Parse()

	if *stateDirFlag == "" || *backendURLFlag == "" {
		return errors.New("state-dir and backend-url are required")
	}
	if err := os.MkdirAll(*stateDirFlag, 0o700); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}
	backendURL, err := url.Parse(*backendURLFlag)
	if err != nil || backendURL.Scheme != "http" || backendURL.Host == "" {
		return fmt.Errorf("invalid backend URL %q", *backendURLFlag)
	}

	hostname := normalizeHostname(*hostnameFlag)
	var outputMu sync.Mutex
	var serveMu sync.Mutex
	serveEnabled := *serveFlag
	var lastListenFailure time.Time
	var listener io.Closer
	var httpServer *http.Server

	srv := &tsnet.Server{
		Dir:      *stateDirFlag,
		Hostname: hostname,
		UserLogf: func(format string, args ...any) {
			message := fmt.Sprintf(format, args...)
			for _, token := range strings.Fields(message) {
				if strings.HasPrefix(token, "https://") {
					emit(&outputMu, event{Type: "auth-url", AuthURL: strings.TrimSpace(token)})
					break
				}
			}
		},
	}
	if *tagsFlag != "" {
		for _, tag := range strings.Split(*tagsFlag, ",") {
			if tag = strings.TrimSpace(tag); tag != "" {
				srv.AdvertiseTags = append(srv.AdvertiseTags, tag)
			}
		}
	}
	defer srv.Close()

	if err := srv.Start(); err != nil {
		return fmt.Errorf("start tsnet: %w", err)
	}
	lc, err := srv.LocalClient()
	if err != nil {
		return fmt.Errorf("open tsnet local client: %w", err)
	}

	proxy := httputil.NewSingleHostReverseProxy(backendURL)
	proxy.Director = func(request *http.Request) {
		originalHost := request.Host
		request.URL.Scheme = backendURL.Scheme
		request.URL.Host = backendURL.Host
		request.Host = backendURL.Host
		request.Header.Set("X-Forwarded-Proto", "https")
		request.Header.Set("X-Forwarded-Host", originalHost)
	}
	proxy.ErrorHandler = func(writer http.ResponseWriter, request *http.Request, proxyErr error) {
		http.Error(writer, "Supaterm backend unavailable", http.StatusBadGateway)
	}
	handler := &proxyHandler{proxy: proxy, local: &tailscaleClient{client: lc}}
	stopServeLocked := func() {
		if httpServer != nil {
			_ = httpServer.Close()
		} else if listener != nil {
			_ = listener.Close()
		}
		listener = nil
		httpServer = nil
		handler.mu.Lock()
		handler.owner = ""
		handler.ownerReady = false
		handler.mu.Unlock()
	}
	stopServe := func() {
		serveMu.Lock()
		defer serveMu.Unlock()
		stopServeLocked()
	}

	startServe := func(status *ipnstate.Status) {
		serveMu.Lock()
		defer serveMu.Unlock()
		if !serveEnabled || status == nil || status.BackendState != "Running" {
			return
		}
		if !lastListenFailure.IsZero() && time.Since(lastListenFailure) < 5*time.Second {
			return
		}
		owner := statusOwner(status)
		if owner == "" {
			lastListenFailure = time.Now()
			emit(&outputMu, event{Type: "error", Message: "Tailscale did not report an account owner"})
			return
		}
		if listener != nil {
			handler.mu.RLock()
			ownerMatches := handler.ownerReady && handler.owner == owner
			handler.mu.RUnlock()
			if ownerMatches {
				return
			}
			stopServeLocked()
		}
		ln, listenErr := srv.ListenTLS("tcp", ":443")
		if listenErr != nil {
			lastListenFailure = time.Now()
			emit(&outputMu, event{
				Type:    "error",
				Message: fmt.Sprintf("Tailscale HTTPS could not start; enable MagicDNS and HTTPS certificates in your tailnet settings: %v", listenErr),
			})
			return
		}
		lastListenFailure = time.Time{}
		listener = ln
		enabled := serveEnabled
		handler.mu.Lock()
		handler.owner = owner
		handler.ownerReady = true
		handler.mu.Unlock()
		server := &http.Server{Handler: handler}
		httpServer = server
		dnsName := magicDNSName(status)
		endpointURL := ""
		if dnsName != "" {
			endpointURL = "https://" + dnsName
		}
		emit(&outputMu, event{
			Type:           "running",
			State:          status.BackendState,
			Hostname:       hostname,
			DNSName:        dnsName,
			URL:            endpointURL,
			OwnerLoginName: owner,
			TailscaleIPs:   statusIPs(status),
			Enabled:        &enabled,
		})
		go func() {
			if serveErr := server.Serve(ln); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
				serveMu.Lock()
				if httpServer == server {
					stopServeLocked()
				}
				serveMu.Unlock()
				emit(&outputMu, event{Type: "error", Message: serveErr.Error()})
			}
		}()
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		lastState := ""
		lastAuthURL := ""
		for {
			select {
			case <-ticker.C:
				status, statusErr := lc.Status(ctx)
				if statusErr != nil {
					emit(&outputMu, event{Type: "error", Message: statusErr.Error()})
					continue
				}
				serveMu.Lock()
				enabled := serveEnabled
				serveMu.Unlock()
				if status.BackendState != lastState || status.AuthURL != lastAuthURL {
					lastState = status.BackendState
					lastAuthURL = status.AuthURL
					emit(&outputMu, event{
						Type:           "state",
						State:          status.BackendState,
						AuthURL:        status.AuthURL,
						Hostname:       hostname,
						DNSName:        magicDNSName(status),
						TailscaleIPs:   statusIPs(status),
						OwnerLoginName: statusOwner(status),
						Enabled:        &enabled,
					})
				}
				if status.BackendState != "Running" {
					stopServe()
				}
				startServe(status)
			case <-ctx.Done():
				return
			}
		}
	}()

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var input command
		if err := json.Unmarshal(scanner.Bytes(), &input); err != nil {
			continue
		}
		switch input.Type {
		case "serve":
			serveMu.Lock()
			serveEnabled = input.Enabled != nil && *input.Enabled
			enabled := serveEnabled
			if !serveEnabled {
				stopServeLocked()
			}
			if serveEnabled {
				lastListenFailure = time.Time{}
			}
			serveMu.Unlock()
			emit(&outputMu, event{Type: "serve", Enabled: &enabled})
		case "stop":
			return nil
		}
	}
	return scanner.Err()
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
