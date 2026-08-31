package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
// Commands route through the gitCommand helper (locale pinned to C, see
// below) over the runCommandContext seam so tests can stub the git binary
// and inject failures.
func repoRoot(workdir string) (root, relCwd string, err error) {
	cmd := gitCommand(context.Background(), workdir,
		"rev-parse", "--is-inside-work-tree")
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

	cmd = gitCommand(context.Background(), workdir,
		"rev-parse", "--show-toplevel")
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
	cmd = gitCommand(context.Background(), workdir,
		"rev-parse", "--show-prefix")
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

// gitCommand builds a git command pinned to the C/POSIX locale so git's
// stderr diagnostics are parseable regardless of the user's LANG. git
// localizes its messages ("fatal: not a git repository" becomes
// "Schwerwiegend: Kein Git-Repository…" under de_DE), and the actionable
// error below substring-matches the English text. LC_ALL/LANG are stripped
// from the inherited environment and re-appended as C so no duplicate-key
// ambiguity remains (how duplicates resolve varies across libc/git builds).
func gitCommand(ctx context.Context, workdir string, arg ...string) runner {
	cmd := runCommandContext(ctx, "git", append([]string{"-C", workdir}, arg...)...)
	cmd.SetEnv(pinnedCEEnv())
	return cmd
}

// pinnedCEEnv returns the inherited environment with LC_ALL/LANG forced to C.
func pinnedCEEnv() []string {
	env := make([]string, 0, len(os.Environ())+2)
	for _, kv := range os.Environ() {
		if key, _, ok := strings.Cut(kv, "="); ok && (key == "LC_ALL" || key == "LANG") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "LC_ALL=C", "LANG=C")
}

// resolveWorkspaceParent detects the cheasee-pi workspace-parent layout and
// returns the workspace root: init runs in an EMPTY folder and leaves exactly
// a sibling .bare plus one worktree leaf holding cheasee-settings.json — the
// .bare sibling is the invariant, the settings-bearing leaf the workspace.
// Runs only when no ancestor walk found a marker, so a genuine
// non-initialized folder never resolves. Fail-closed: no .bare, no settings
// leaf, or more than one settings leaf (user-created ambiguity) → false.
func resolveWorkspaceParent(parent string) (string, bool) {
	if _, err := os.Stat(filepath.Join(parent, ".bare")); err != nil {
		return "", false
	}
	entries, err := os.ReadDir(parent)
	if err != nil {
		return "", false
	}
	var leaf string
	for _, e := range entries {
		if e.Name() == ".bare" || !e.IsDir() {
			continue
		}
		if _, err := os.Stat(cheaseeSettingsPath(filepath.Join(parent, e.Name()))); err == nil {
			if leaf != "" {
				return "", false // ambiguous — refuse, user should cd
			}
			leaf = e.Name()
		}
	}
	return filepath.Join(parent, leaf), leaf != ""
}
