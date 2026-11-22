//go:build !windows

package main

import (
	"errors"
	"os"
	"syscall"
)

// lockFileExclusive takes an exclusive flock on f, blocking until every other
// holder releases it. flock is held on the open file description, so two
// `cheasee-pi start` processes — and two goroutines of one process — contend for
// it the same way.
//
// EINTR is retried: a signal delivered while waiting does not mean the lock was
// refused, and reporting it would fail a publication that should have queued.
func lockFileExclusive(f *os.File) error {
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
		if err == nil || !errors.Is(err, syscall.EINTR) {
			return err
		}
	}
}

// unlockFile releases the flock. The kernel also releases it when the process
// exits, so a crashed start never leaves the lock behind.
func unlockFile(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}
