package main

import (
	"fmt"
	"strings"
)

// The preconditions the use case checks before it writes anything, plus the
// dry-run verdict.

// refuseInUseWorkspace stops the migration while a session holds the workspace:
// rewriting the settings under a running pi is exactly the race the in-use claim
// exists to expose.
func refuseInUseWorkspace(root string) error {
	claims, err := liveSessionClaims(root)
	if err != nil {
		return err
	}
	if len(claims) == 0 {
		return nil
	}
	// Name the recovery too: a claim outlives a session killed without its
	// deferred release, and "close the session" is not actionable when there is
	// none. `down` purges the claims of the containers it removes.
	return fmt.Errorf("workspace is in use by a running session (%s) — close it with Ctrl+D, then re-run; if no session is running, `cheasee-pi down` clears the stale claim",
		strings.Join(claims, ", "))
}

// checkCloneDeletable refuses the paths the migration must never walk: an unsafe
// component between the workspace and the checkout means the deletion would reach
// outside the workspace.
func checkCloneDeletable(clone retireCloneState, removable bool) error {
	if !removable || clone.Unsafe == "" {
		return nil
	}
	return unsafeCloneError(clone)
}

// dryRunReport reports what a live run would do — and touches nothing.
func dryRunReport(rep retireReport, removeClone bool) retireReport {
	if removeClone {
		rep.CloneRemoved = append(rep.CloneRemoved, retiredCloneRel)
	}
	return rep
}
