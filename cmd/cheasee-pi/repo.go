package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// repoRoot resolves the git worktree root containing workdir and the
// slash-separated relative path from that root to workdir ("." when workdir
// IS the root). Non-git directories are refused with an actionable error —
// cheasee-pi only runs from the user's own git repository.
//
// Uses `git rev-parse --is-inside-work-tree` / `--show-toplevel`, which is
// worktree-safe: nested repos resolve to the innermost worktree, and git
// worktree checkouts report their own toplevel, not the main checkout.
// Commands route through the runCommandContext seam so tests can stub the
// git binary and inject failures.
func repoRoot(workdir string) (root, relCwd string, err error) {
	cmd := runCommandContext(context.Background(), "git",
		"-C", workdir, "rev-parse", "--is-inside-work-tree")
	out, err := cmd.Output()
	if err != nil {
		// Common case: workdir is not inside any repo. git's own stderr
		// ("fatal: not a git repository ...") is more actionable than a bare
		// exit status — surface it with the remedy. Non-ExitError failures
		// (git missing on PATH, bad -C dir) fall through to the wrapped error.
		if ee, ok := err.(*exec.ExitError); ok &&
			strings.Contains(string(ee.Stderr), "not a git repository") {
			return "", "", fmt.Errorf("not a git repository: %q is not inside a git work tree — run cheasee-pi from your own git repository", workdir)
		}
		return "", "", fmt.Errorf("check git repository: %w", err)
	}
	if strings.TrimSpace(string(out)) != "true" {
		return "", "", fmt.Errorf("not a git repository: %q is not inside a git work tree (run cheasee-pi from your own git repo)", workdir)
	}

	cmd = runCommandContext(context.Background(), "git",
		"-C", workdir, "rev-parse", "--show-toplevel")
	out, err = cmd.Output()
	if err != nil {
		return "", "", fmt.Errorf("resolve git repository root: %w", err)
	}
	root = strings.TrimSpace(string(out))
	if root == "" {
		return "", "", fmt.Errorf("resolve git repository root: empty toplevel for %q", workdir)
	}

	// relCwd comes from git itself (--show-prefix), not from filepath math
	// against a logical cwd: git resolves symlinks (macOS /tmp → /private/tmp),
	// so a symlinked cwd cannot produce a wrong ../-laden relative path.
	// Output is already slash-separated on every platform (Windows included)
	// and carries a trailing slash when non-empty; "" at the toplevel.
	cmd = runCommandContext(context.Background(), "git",
		"-C", workdir, "rev-parse", "--show-prefix")
	out, err = cmd.Output()
	if err != nil {
		return "", "", fmt.Errorf("resolve relative cwd: %w", err)
	}
	rel := strings.TrimSuffix(strings.TrimSpace(string(out)), "/")
	if rel == "" {
		rel = "."
	}
	return root, rel, nil
}
