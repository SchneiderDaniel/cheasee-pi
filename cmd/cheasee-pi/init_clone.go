package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// gitCloneWorktree bare-clones the user's project repo to <parent>/.bare and
// adds the main worktree (checked out at the bare HEAD, detached) into
// workdir — the exact layout worktree-fix.sh expects inside the container
// (/workspaces/main + /workspaces/.bare as sibling mounts).
//
// Authentication goes through the gh credential helper (git -c
// credential.helper), never a token-bearing clone URL: git persists
// remote.origin.url verbatim in .bare/config, so an embedded token would be
// written to disk in plain text. URLs that carry userinfo are refused.
//
// The bare clone is full (no --depth/--single-branch): a later
// `worktree add` of non-default branches must stay possible from the same
// .bare. `worktree add --detach` takes NO branch argument — bare clones
// leave no refs/remotes/origin/HEAD symbolic ref, so the old
// symbolic-ref-based default-branch detection silently fell back to "main"
// and hard-failed on master-default repos; no-branch add checks out the bare
// HEAD on both.
func gitCloneWorktree(ctx context.Context, repoURL, workdir string) error {
	owner, repo := ParseGitHubURL(repoURL)
	if owner == "" || repo == "" {
		return fmt.Errorf("invalid repo URL: %s", redactToken(repoURL))
	}
	// Refuse URLs with embedded credentials before git ever sees them.
	if u, err := url.Parse(repoURL); err == nil && u.User != nil && u.User.Username() != "git" {
		return fmt.Errorf("refusing repo URL with embedded credentials (git would persist them in .bare/config): %s", redactToken(repoURL))
	}

	parentDir := filepath.Dir(workdir)
	bareDir := filepath.Join(parentDir, ".bare")

	// Pre-check: fail closed on a non-empty .bare collision (two workspaces
	// under one parent share the fixed name). A stray empty dir (e.g.
	// docker-created) is fine — git clones into it.
	entries, err := os.ReadDir(bareDir)
	switch {
	case err == nil && len(entries) > 0:
		return fmt.Errorf("bare clone collision: %s already exists and is not empty — move or remove it, or initialize in a folder under a different parent", bareDir)
	case err != nil && !os.IsNotExist(err):
		return fmt.Errorf("check bare dir %s: %w", bareDir, err)
	}
	barePreExisted := err == nil

	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return fmt.Errorf("create parent dir: %w", err)
	}

	// "owner/repo" shorthand → canonical https URL (git would otherwise
	// treat the bare form as a local filesystem path).
	cloneURL := repoURL
	if !strings.Contains(repoURL, "://") && !strings.Contains(repoURL, "@") && !strings.Contains(repoURL, ":") {
		cloneURL = "https://github.com/" + owner + "/" + repo + ".git"
	}

	cmd := runCommandContext(ctx, "git",
		"-c", "credential.helper=!gh auth git-credential",
		"clone", "--bare", cloneURL, bareDir,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		if !barePreExisted {
			os.RemoveAll(bareDir) // no half-cloned residue on failure/cancel
		}
		return fmt.Errorf("bare clone failed: %w\n%s", err, redactToken(string(out)))
	}

	wtCmd := runCommandContext(ctx, "git",
		"--git-dir", bareDir,
		"worktree", "add", "--detach", workdir,
	)
	if out, err := wtCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("worktree add failed: %w\n%s", err, redactToken(string(out)))
	}

	fmt.Fprintf(os.Stderr, "  ✓ Cloned (bare + worktree) to %s\n", workdir)
	return nil
}
