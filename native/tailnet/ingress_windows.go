package main

import (
	"context"
	"net"

	winio "github.com/tailscale/go-winio"
)

func dialIngress(ctx context.Context, address string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, address)
}
