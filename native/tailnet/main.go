// Command supaterm-tailnet joins a tailnet with tsnet and hands each inbound
// connection to the Supaterm server over a private local socket. The server
// drives it with NDJSON over stdin and reads events from stdout.
package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"

	tailscaleroot "tailscale.com"
	"tailscale.com/envknob"
	"tailscale.com/hostinfo"
	"tailscale.com/ipn"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
)

const maxCommandBytes = 1 << 20

func main() {
	os.Exit(run(os.Stdin, os.Stdout, os.Stderr))
}

func run(stdin io.Reader, stdout, stderr io.Writer) int {
	out := &emitter{w: stdout}
	logf := stderrLogf(stderr)
	lines := bufio.NewScanner(stdin)
	lines.Buffer(make([]byte, 0, 4096), maxCommandBytes)
	if !lines.Scan() {
		return 0
	}
	cfg, err := parseConfigure(lines.Bytes())
	if err != nil {
		out.error("protocol", err, true)
		return 1
	}
	out.send(helloMsg{
		header:           newHeader("hello"),
		Version:          sidecarVersion(),
		TailscaleVersion: strings.TrimSpace(tailscaleroot.VersionDotTxt),
	})

	scrubEnv()
	hostinfo.SetApp("supaterm")
	if !cfg.AllowLogging {
		envknob.SetNoLogsNoSupport()
	}
	if err := secureStateDir(filepath.Dir(cfg.Dir)); err != nil {
		out.error("state-dir", err, true)
		return 1
	}

	srv := &tsnet.Server{
		Dir:           cfg.Dir,
		Hostname:      cfg.Hostname,
		AdvertiseTags: cfg.Tags,
		AuthKey:       cfg.AuthKey,
		ControlURL:    ipn.DefaultControlURL,
		UserLogf:      logger.Discard,
		Logf:          logf,
	}
	if err := srv.Start(); err != nil {
		out.error("tsnet-start", err, true)
		return 1
	}
	defer srv.Close()
	lc, err := srv.LocalClient()
	if err != nil {
		out.error("tsnet-start", err, true)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cmds := make(chan command)
	go readCommands(lines, cmds, out)
	newNode(srv, lc, cfg, out, logf).run(ctx, cmds)
	return 0
}

// readCommands closes cmds when stdin ends, which the node treats as shutdown.
func readCommands(lines *bufio.Scanner, cmds chan<- command, out *emitter) {
	defer close(cmds)
	for lines.Scan() {
		c, err := parseCommand(lines.Bytes())
		if err != nil {
			out.error("protocol", err, false)
			continue
		}
		cmds <- c
	}
	if err := lines.Err(); err != nil {
		out.error("protocol", err, false)
	}
}

// scrubEnv clears TS_* and TSNET_* so an inherited variable cannot change the
// control server, credentials or login behavior. envknob.Setenv also resets
// knobs that were registered from the environment at init.
func scrubEnv() {
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		upper := strings.ToUpper(name)
		if strings.HasPrefix(upper, "TS_") || strings.HasPrefix(upper, "TSNET_") {
			envknob.Setenv(name, "")
			os.Unsetenv(name)
		}
	}
}

// sidecarVersion is the git revision: Go leaves a subdirectory module's
// version at (devel), but still stamps the commit.
func sidecarVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "(devel)"
	}
	revision, dirty := "", false
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			revision = s.Value[:min(len(s.Value), 12)]
		case "vcs.modified":
			dirty = s.Value == "true"
		}
	}
	switch {
	case revision == "":
		return info.Main.Version
	case dirty:
		return revision + "-dirty"
	}
	return revision
}

var secretPattern = regexp.MustCompile(`https?://\S+/a/\S+|tskey-\S+`)

// stderrLogf drops verbose backend lines, matching tailscaled's default stderr
// level, and redacts login URLs and auth keys, which control and the backend
// print in full.
func stderrLogf(w io.Writer) logger.Logf {
	var mu sync.Mutex
	return func(format string, args ...any) {
		if strings.Contains(format, "[v1] ") || strings.Contains(format, "[v2] ") || strings.Contains(format, "[v\x00JSON]") {
			return
		}
		msg := secretPattern.ReplaceAllString(fmt.Sprintf(format, args...), "[redacted]")
		mu.Lock()
		defer mu.Unlock()
		io.WriteString(w, strings.TrimRight(msg, "\n")+"\n")
	}
}
