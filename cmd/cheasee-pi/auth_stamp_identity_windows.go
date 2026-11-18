//go:build windows

package main

import "os"

// authFileIdentity has no portable inode on Windows. The stamp falls back to
// size + mtime_ns alone — both flip on a credential rewrite (atomicWrite
// renames a fresh file into place), so drift detection still works.
func authFileIdentity(_ os.FileInfo) string {
	return ""
}
