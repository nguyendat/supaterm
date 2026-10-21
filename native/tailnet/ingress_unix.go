//go:build !windows

package main

import (
	"context"
	"net"
)

func dialIngress(ctx context.Context, address string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", address)
}
