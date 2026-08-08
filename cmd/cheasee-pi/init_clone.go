package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// runInitClone clones a repo into workdir (fork+clone phase of init).
func runInitClone(ctx context.Context, token, cloneURL, workdir string) error {
	sourceOwner, sourceRepoName := ParseGitHubURL(cloneURL)
	if sourceOwner == "" || sourceRepoName == "" {
		return fmt.Errorf("invalid clone URL: %s", cloneURL)
	}

	// Check if target dir already has content
	if fi, err := os.Stat(workdir); err == nil && fi.IsDir() {
		entries, _ := os.ReadDir(workdir)
		if len(entries) > 0 {
			// Has .git → repo exists, skip clone
			if _, err := os.Stat(filepath.Join(workdir, ".git")); err == nil {
				fmt.Fprintf(os.Stderr, "  ℹ Repository already exists at %s, skipping clone\n", workdir)
				return nil
			}
			// Non-empty, no .git → refuse
			return fmt.Errorf("directory %s exists and is not empty. Remove it or use --workdir to point elsewhere", workdir)
		}
	}

	if err := gitCloneWorktree(ctx, token, cloneURL, workdir); err != nil {
		return fmt.Errorf("clone fork: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Cloned %s/%s to %s\n", sourceOwner, sourceRepoName, workdir)
	return nil
}
