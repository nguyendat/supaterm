//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSecureStateDirCreatesPrivateDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state", "tailnet")
	if err := secureStateDir(dir); err != nil {
		t.Fatal(err)
	}
	assertMode(t, dir, 0o700)
}

func TestSecureStateDirTightensExistingDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tailnet")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := secureStateDir(dir); err != nil {
		t.Fatal(err)
	}
	assertMode(t, dir, 0o700)
}

func TestSecureStateDirRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "elsewhere")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "tailnet")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := secureStateDir(link); err == nil {
		t.Fatal("a symlinked state dir must be rejected")
	}
	assertMode(t, target, 0o755)
}

func TestSecureStateDirRejectsFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tailnet")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := secureStateDir(path); err == nil {
		t.Fatal("a file must be rejected")
	}
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := fi.Mode().Perm(); got != want {
		t.Fatalf("%s mode = %#o, want %#o", path, got, want)
	}
}
