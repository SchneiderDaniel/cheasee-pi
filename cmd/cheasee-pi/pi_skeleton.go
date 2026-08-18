package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// piSkeletonDirs are the project-local .pi resource dirs pre-created by the
// init scaffold so they exist before pi starts. Pi has no init subcommand
// (its CLI is install/remove/update/list/config/auth only), and it reads
// these dirs only when present — without them a fresh workspace silently
// has no skills/extensions/prompts/themes/sessions/agent locations. The
// names must match the exact relative paths the embedded pi template
// references (sessionDir .pi/sessions, skills/prompts/extensions arrays).
var piSkeletonDirs = []string{
	"skills",
	"extensions",
	"prompts",
	"themes",
	"sessions",
	"agent",
}

// ensurePiSkeleton idempotently pre-creates the .pi skeleton directory tree
// in a workspace. Git does not track empty directories, so the scaffold
// re-creates them on every init; os.MkdirAll on an existing dir is a no-op
// returning nil, so a repo-committed .pi tree (cheasee-pi itself commits
// .pi/settings.json) is never modified — the never-overwrite contract.
func ensurePiSkeleton(workdir string) error {
	for _, dir := range piSkeletonDirs {
		if err := os.MkdirAll(filepath.Join(workdir, ".pi", dir), 0755); err != nil {
			return fmt.Errorf("create .pi/%s: %w", dir, err)
		}
	}
	return nil
}
