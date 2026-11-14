package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// claimLiveSession publishes the live-session claim and returns its release. A
// failed claim write degrades the ui guard to advisory, never a failed start;
// the release runs on every exit path of the caller.
func claimLiveSession(root, name, sessionID string) func() {
	sessionDir := filepath.Join(root, ".pi", "sessions")
	if err := writeInUseClaim(sessionDir, sessionID, name); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ in-use claim: %v\n", err)
	}
	return func() {
		if err := removeInUseClaim(sessionDir, sessionID); err != nil {
			fmt.Fprintf(os.Stderr, "  ⚠ in-use claim cleanup: %v\n", err)
		}
	}
}

// prepareLaunch clears the road for the exec: a pre-start orphan scan
// (best-effort; PPid=1 orphans only — age reaping is clean's job, a pre-start
// age sweep could kill a long-running session the user still has attached
// elsewhere) and a container /tmp reclaim before pi starts.
func prepareLaunch(ctx context.Context, name string) error {
	killed, err := scanOrphans(ctx, name, 0, false)
	if err != nil {
		return fmt.Errorf("pre-start orphan scan: %w", err)
	}
	if len(killed) > 0 {
		fmt.Fprintf(os.Stderr, "  ✓ Killed %d orphaned pi process(es)\n", len(killed))
	}

	// Reclaim container /tmp scratch before pi starts (subagent runs and
	// interrupted builds leave go-build/pi-session dirs that fill a tight
	// overlay until pi's session mkdtemp hits ENOSPC). Non-fatal.
	if err := cleanContainerTmp(ctx, name); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ %v\n", err)
	}
	return nil
}

// execPiSession runs the interactive exec and then reaps the session by marker.
// The docker exec client just exited (user quit or disconnected); on disconnect
// pi keeps running with PPid=0, invisible to the orphan scan — without this
// every detached start leaks a pi.
func execPiSession(ctx context.Context, name string, env map[string]string,
	target, sessionID string) error {
	execErr := execPIContainer(name, env, target)
	if err := killSessionByMarker(ctx, name, sessionID); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ session reaper: %v\n", err)
	}
	return execErr
}
