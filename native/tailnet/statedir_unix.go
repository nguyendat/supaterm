//go:build !windows

package main

import (
	"fmt"
	"io/fs"
	"os"
	"syscall"
)

func secureStateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	fi, err := ownedDir(dir)
	if err != nil {
		return err
	}
	if fi.Mode().Perm() == 0o700 {
		return nil
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	if fi, err = ownedDir(dir); err != nil {
		return err
	}
	if perm := fi.Mode().Perm(); perm != 0o700 {
		return fmt.Errorf("%s has mode %#o, want 0700", dir, perm)
	}
	return nil
}

func ownedDir(dir string) (fs.FileInfo, error) {
	fi, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if fi.Mode().Type() != fs.ModeDir {
		return nil, fmt.Errorf("%s is not a directory (mode %v)", dir, fi.Mode())
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || int(st.Uid) != os.Getuid() {
		return nil, fmt.Errorf("%s is not owned by the current user", dir)
	}
	return fi, nil
}
