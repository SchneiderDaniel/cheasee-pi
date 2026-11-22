package main

import (
	"context"
	"fmt"
	"os"
)

// ──────────────────────────────────────────────
// Discovery wiring for the start use case
//
// Both steps are warnings, never aborts: a working session must not be refused
// over a registry fault, and an empty snapshot keeps the ui bind-mount target a
// FILE. Neither is silent — the operator sees the cause on stderr.
// ──────────────────────────────────────────────

// materializeInstanceSnapshot publishes the discovery snapshot BEFORE compose
// creates the ui container: the ui service bind-mounts that FILE, and docker
// creates a DIRECTORY at a missing source.
func materializeInstanceSnapshot(ctx context.Context) {
	if err := ensureInstanceSnapshot(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ instance discovery: %v\n", err)
	}
}

// registerInstanceWithWarning records this workspace and refreshes the shared
// snapshot so peer sidecars (and this one) can list and link it.
func registerInstanceWithWarning(ctx context.Context, root string) {
	if err := registerRunningInstance(ctx, root); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ instance discovery: %v\n", err)
	}
}
