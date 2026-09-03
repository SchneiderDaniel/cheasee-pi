package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// canonicalRepoURL normalizes a repo URL to the canonical https form used by
// both the clone phase and the settings scaffold: "owner/repo" shorthand and
// scp-style git@github.com:owner/repo become https://github.com/owner/repo.git;
// https forms (with/without .git, trailing slash) pass through unchanged;
// ssh://git@... passes through verbatim (deliberate ssh users keep their
// transport). Refuses URLs with embedded credentials — git persists
// remote.origin.url verbatim in .bare/config, so a token-bearing URL would be
// written to disk in plain text.
func canonicalRepoURL(repoURL string) (string, error) {
	owner, repo := parseGitHubRemote(repoURL)
	if owner == "" || repo == "" {
		return "", fmt.Errorf("invalid repo URL: %s", redactToken(repoURL))
	}
	// Refuse URLs with embedded credentials before git ever sees them.
	if u, err := url.Parse(repoURL); err == nil && u.User != nil && u.User.Username() != "git" {
		return "", fmt.Errorf("refusing repo URL with embedded credentials (git would persist them in .bare/config): %s", redactToken(repoURL))
	}

	// "owner/repo" shorthand → canonical https URL (git would otherwise
	// treat the bare form as a local filesystem path). scp-style ssh
	// git@github.com:owner/repo → https too: the clone runs with the gh
	// credential helper, which speaks https only — ssh dies with publickey
	// errors on machines without a key. ssh://git@... stays passthrough
	// (deliberate ssh users keep their transport).
	switch {
	case !strings.Contains(repoURL, "://") && !strings.Contains(repoURL, "@") && !strings.Contains(repoURL, ":"):
		return "https://github.com/" + owner + "/" + repo + ".git", nil
	case strings.HasPrefix(repoURL, "git@") && strings.Contains(repoURL, "github.com:"):
		return "https://github.com/" + owner + "/" + repo + ".git", nil
	}
	return repoURL, nil
}

// gitCloneWorktree bare-clones the user's project repo to <parent>/.bare and
// adds the main worktree (checked out on the repo's default branch) into
// workdir — the exact layout worktree-fix.sh expects inside the container
// (/workspaces/main + /workspaces/.bare as sibling mounts).
//
// Authentication goes through the gh credential helper (git -c
// credential.helper), never a token-bearing clone URL: git persists
// remote.origin.url verbatim in .bare/config, so an embedded token would be
// written to disk in plain text. URLs that carry userinfo are refused by
// canonicalRepoURL.
//
// The bare clone is full (no --depth/--single-branch): a later
// `worktree add` of non-default branches must stay possible from the same
// .bare. Bare clones carry the default branch directly as refs/heads/<name>
// (no refs/remotes/origin/HEAD symbolic ref), so the default branch is read
// from the bare HEAD itself via symbolic-ref; the worktree is then attached
// to it. This keeps the workspace on a named branch (no "detached HEAD"
// footer state for pi) and works for every default-branch name (main,
// master, …). A bare HEAD that cannot be resolved to a branch name (exotic
// detached-edge case) falls back to the old `worktree add --detach` bare
// HEAD checkout.
//
// A bare clone carries no remote-tracking setup: `remote.origin.fetch` is
// unset and the default branch has no upstream, so the worktree branch
// would silently diverge from origin (editors like Zed then show no
// ahead/behind, their pull targets nothing, and a push is rejected
// non-fast-forward). wireUpstream restores the normal-clone tracking so the
// workspace behaves like a regular checkout from the start.
func gitCloneWorktree(ctx context.Context, repoURL, workdir string) error {
	cloneURL, err := canonicalRepoURL(repoURL)
	if err != nil {
		return err
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

	// cloneURL is already canonical (canonicalRepoURL); the gh credential
	// helper handles https auth.
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

	// A cancelled parent (Ctrl-C) between the two commands must not proceed
	// to worktree add — that would leave the bare clone on disk without the
	// worktree. Clean up the bare dir we created, mirroring the clone-failure
	// path.
	select {
	case <-ctx.Done():
		if !barePreExisted {
			os.RemoveAll(bareDir)
		}
		return ctx.Err()
	default:
	}

	branch := gitDefaultBranch(ctx, bareDir)
	wtArgs := []string{"--git-dir", bareDir, "worktree", "add"}
	if branch != "" {
		wtArgs = append(wtArgs, workdir, branch)
	} else {
		wtArgs = append(wtArgs, "--detach", workdir)
	}
	wtCmd := runCommandContext(ctx, "git", wtArgs...)
	if out, err := wtCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("worktree add failed: %w\n%s", err, redactToken(string(out)))
	}

	// Named-branch worktree: give it a remote-tracking ref and an upstream
	// (stored in the shared .bare config, visible to every worktree). A bare
	// clone ships without remote.origin.fetch and without a tracking ref, so
	// without this the branch diverges from origin in silence. Purely local
	// operations — the objects already came down with the full bare clone.
	if branch != "" {
		if err := wireUpstream(ctx, bareDir, branch); err != nil {
			return err
		}
	}

	fmt.Fprintf(os.Stderr, "  ✓ Cloned (bare + worktree) to %s\n", workdir)
	return nil
}

// wireUpstream adds the remote-tracking setup a bare clone omits: the
// remote.origin.fetch refspec (so later `git fetch` in any worktree resolves
// all branches), the default branch's remote-tracking ref, and the upstream
// binding branch.<name>.remote/merge. All three write into the shared .bare
// config, so every worktree on the repo sees the tracking. All local, no
// network round trip.
func wireUpstream(ctx context.Context, bareDir, branch string) error {
	trackingRef := "refs/remotes/origin/" + branch
	cmds := [][]string{
		{"--git-dir", bareDir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"},
		{"--git-dir", bareDir, "update-ref", trackingRef, branch},
		{"--git-dir", bareDir, "branch", "--set-upstream-to", "origin/" + branch, branch},
	}
	for _, args := range cmds {
		if out, err := runCommandContext(ctx, "git", args...).CombinedOutput(); err != nil {
			return fmt.Errorf("set upstream tracking for %s: %w\n%s", branch, err, redactToken(string(out)))
		}
	}
	return nil
}

// gitDefaultBranch resolves the bare repo's default branch name from its
// HEAD symbolic ref (refs/heads/<name>). Bare clones keep branches directly
// under refs/heads and carry no refs/remotes/origin/HEAD, so HEAD is the
// single source of truth. Returns "" when HEAD is detached or missing — the
// caller then falls back to a detached worktree add (bare HEAD checkout).
func gitDefaultBranch(ctx context.Context, bareDir string) string {
	out, err := runCommandContext(ctx, "git", "--git-dir", bareDir, "symbolic-ref", "HEAD").CombinedOutput()
	if err != nil {
		return ""
	}
	ref := strings.TrimSpace(string(out)) // e.g. refs/heads/main
	const headsPrefix = "refs/heads/"
	if !strings.HasPrefix(ref, headsPrefix) {
		return ""
	}
	return strings.TrimPrefix(ref, headsPrefix)
}

// removeInitResidue best-effort cleans a half-initialized workspace after a
// post-clone init failure (scaffold/auth-save/API-key phase): the main
// worktree plus the sibling .bare. The empty-folder probe guarantees only
// freshly cloned + scaffolded files exist in the workdir, so removal cannot
// destroy user data. Missing worktree/.bare is a silent no-op (best-effort
// by contract); mirrors gitCloneWorktree's clone-failure cleanup paths.
func removeInitResidue(workdir string) {
	bareDir := filepath.Join(filepath.Dir(workdir), ".bare")

	fmt.Fprintf(os.Stderr, "  ⚠ Init failed — removing incomplete workspace residue (worktree + .bare).\n")

	// Prune the bare's worktree registration first (best-effort — a
	// stubbed/incomplete worktree errors here, harmless), then remove the
	// worktree dir and the sibling .bare outright.
	_ = runCommandContext(context.Background(), "git", "--git-dir", bareDir, "worktree", "remove", "--force", workdir).Run()
	os.RemoveAll(workdir)
	os.RemoveAll(bareDir)
}
