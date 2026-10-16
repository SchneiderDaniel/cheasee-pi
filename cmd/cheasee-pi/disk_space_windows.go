//go:build windows

package main

import "errors"

// platformFreeBytes is unsupported on Windows: Docker Desktop runs the data
// root inside its Linux VM, so the host filesystem cannot be probed (and the
// daemon-reported path is a path inside the VM). Returning an error makes
// checkBuildDiskSpace fail open — the build is never blocked here.
func platformFreeBytes(string) (uint64, error) {
	return 0, errors.New("free-space probe unsupported on Windows")
}
