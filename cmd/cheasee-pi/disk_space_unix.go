//go:build !windows

package main

import "syscall"

// platformFreeBytes returns the bytes available to unprivileged callers on the
// filesystem containing path.
func platformFreeBytes(path string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return uint64(st.Bavail) * uint64(st.Bsize), nil
}
