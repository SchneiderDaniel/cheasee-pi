//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

// lockFileExclusive takes an exclusive LockFileEx lock on f, blocking until every
// other holder releases it — the Windows counterpart of flock, so a Windows host
// running several `cheasee-pi start`s publishes the snapshot one writer at a time.
func lockFileExclusive(f *os.File) error {
	return windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, new(windows.Overlapped))
}

// unlockFile releases the Windows lock. The system also releases it when the
// handle is closed, so a crashed start never leaves the lock behind.
func unlockFile(f *os.File) error {
	return windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, new(windows.Overlapped))
}
