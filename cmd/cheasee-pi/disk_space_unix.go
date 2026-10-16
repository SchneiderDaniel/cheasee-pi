//go:build !windows

package main

import "golang.org/x/sys/unix"

// platformFreeBytes returns the bytes available to unprivileged callers on the
// filesystem containing path.
func platformFreeBytes(path string) (uint64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, err
	}
	return uint64(st.Bavail) * uint64(st.Bsize), nil
}
