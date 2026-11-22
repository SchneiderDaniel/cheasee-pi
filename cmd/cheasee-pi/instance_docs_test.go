package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 8: docs / migration (static)
//
// The identity change is a behavior change operators hit: pre-change stacks
// keep their slug-only container names and must be recreated, and discovery
// has a deliberate scope (peer labels only — no host paths, no docker access
// from the ui).
// ──────────────────────────────────────────────

func TestDiscovery_docsDocumentPerWorktreeIdentity(t *testing.T) {
	path := filepath.Join("..", "..", "docs", "daily-usage.md")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	doc := string(data)

	for _, want := range []string{
		// per-worktree identity statement
		"per-worktree",
		// migration for stacks created before the change
		"cheasee-pi down",
		"cheasee-pi start",
		// discovery scope: labels only, no host paths, no docker access
		"instance",
		"snapshot",
		"no host paths",
		"never talks to docker",
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("docs/daily-usage.md must state %q (per-worktree identity + migration + discovery scope)", want)
		}
	}
}
