//go:build !windows

package main

import (
	"fmt"
	"os"
	"syscall"
)

// authFileIdentity renders the stable file identity used by authSpec: the
// device and inode pair. An atomic replace (temp file + rename, how
// `cheasee-pi auth` persists) lands on a NEW inode, which is precisely the
// change a single-file bind mount cannot see.
//
// A filesystem that cannot report the inode degrades to the empty string rather
// than failing the stamp: size + mtime_ns still flip on every real write.
func authFileIdentity(fi os.FileInfo) string {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}
	return fmt.Sprintf("%d:%d", uint64(st.Dev), uint64(st.Ino))
}
