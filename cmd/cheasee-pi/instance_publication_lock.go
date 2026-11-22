package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// ──────────────────────────────────────────────
// Snapshot publication lock
//
// Publishing the snapshot is a read-probe-write cycle: list the registry, probe
// docker for liveness, rewrite the file. Two `cheasee-pi start`s finishing out of
// order interleave that cycle — the SLOWER one may have listed the registry
// before the faster one recorded its workspace, yet still write last and
// overwrite the newer view with a shrinking one. The vanished workspace then
// reads as "not running" in every sidecar until the next refresh, which is the
// reported symptom (issue #2155).
//
// The whole cycle therefore runs under one host-wide exclusive lock, and the
// registry is listed INSIDE it: whatever order the processes finish in, the last
// writer re-reads the registry and publishes the complete set.
//
// The lock is a sibling FILE of the snapshot, never the snapshot itself: the
// snapshot is bind-mounted into the `ui` container, so the file the container
// renders must not also be a lock target.
// ──────────────────────────────────────────────

// instanceLockPath is the lock file guarding the snapshot at path.
func instanceLockPath(path string) string {
	return path + ".lock"
}

// withInstancePublicationLock runs fn holding the host-wide snapshot publication
// lock. A lock fault surfaces: publishing without it would reintroduce the
// out-of-order overwrite this lock exists to prevent.
func withInstancePublicationLock(path string, fn func() error) (err error) {
	lockPath := instanceLockPath(path)
	if mkErr := os.MkdirAll(filepath.Dir(lockPath), 0o755); mkErr != nil {
		return fmt.Errorf("create instance state dir for %s: %w", lockPath, mkErr)
	}
	lock, openErr := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o644)
	if openErr != nil {
		return fmt.Errorf("open instance publication lock %s: %w", lockPath, openErr)
	}
	if lockErr := lockFileExclusive(lock); lockErr != nil {
		lock.Close()
		return fmt.Errorf("lock instance publication %s: %w", lockPath, lockErr)
	}
	defer func() {
		err = finishInstancePublicationLock(lock, lockPath, err)
	}()
	return fn()
}

// finishInstancePublicationLock releases and closes the lock file, reporting a
// release fault that would otherwise be swallowed. An fn failure wins: it is the
// cause the operator needs, not the cleanup detail.
func finishInstancePublicationLock(lock *os.File, lockPath string, fnErr error) error {
	unlockErr := unlockFile(lock)
	closeErr := lock.Close()
	if fnErr != nil {
		return fnErr
	}
	if unlockErr != nil {
		return fmt.Errorf("unlock instance publication %s: %w", lockPath, unlockErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close instance publication lock %s: %w", lockPath, closeErr)
	}
	return nil
}
