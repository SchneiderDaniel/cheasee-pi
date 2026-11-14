package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"
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

// sessionReapTimeout bounds the post-exec session reap. The reap runs after the
// interactive exec client is gone, so it cannot wait on user input, and a
// wedged docker exec must not hang the CLI once pi has exited.
const sessionReapTimeout = 30 * time.Second

// execPiSession runs the interactive exec and then reaps the session by marker.
// The docker exec client just exited (user quit or disconnected); on disconnect
// pi keeps running with PPid=0, invisible to the orphan scan — without this
// every detached start leaks a pi.
//
// Two different ctx lifetimes meet here. The exec client runs on the caller's
// ctx, so a cancel (Ctrl-C, signal handler, parent timeout) tears the interactive
// docker exec down instead of letting it run on. The reap then runs detached
// from that cancellation (values preserved, own deadline): the cancel is
// precisely the case where the session we just launched must still be killed,
// and a cancelled ctx would fail the reaper's own docker exec immediately,
// leaking the session the reap exists to remove.
func execPiSession(ctx context.Context, name string, env map[string]string,
	target, sessionID string) error {
	execErr := execPIContainer(ctx, name, env, target)

	reapCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), sessionReapTimeout)
	defer cancel()
	if err := killSessionByMarker(reapCtx, name, sessionID); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ session reaper: %v\n", err)
	}
	return execErr
}
