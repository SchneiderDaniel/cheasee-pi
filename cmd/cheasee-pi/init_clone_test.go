package main

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// redactToken (security, defense in depth)
// ──────────────────────────────────────────────

func TestRedactToken_stripsUserinfo(t *testing.T) {
	in := "clone failed: https://oauth2:SECRETTOKEN@github.com/owner/repo.git"
	out := redactToken(in)
	if strings.Contains(out, "SECRETTOKEN") {
		t.Errorf("token must be redacted from error passthrough: %q", out)
	}
	if !strings.Contains(out, "//***@") {
		t.Errorf("userinfo must be replaced with //***@: %q", out)
	}
}

func TestRedactToken_noColonUserinfo(t *testing.T) {
	in := "fatal: https://ghp_ABC123@github.com/owner/repo"
	out := redactToken(in)
	if strings.Contains(out, "ghp_ABC123") {
		t.Errorf("bare token userinfo must be redacted: %q", out)
	}
}

func TestRedactToken_plainTextUntouched(t *testing.T) {
	in := "worktree add failed: fatal: invalid reference"
	if out := redactToken(in); out != in {
		t.Errorf("text without credentials must pass through unchanged: %q", out)
	}
}

// ──────────────────────────────────────────────
// canonicalRepoURL (entity — shared clone/scaffold normalization)
// ──────────────────────────────────────────────

func TestCanonicalRepoURL(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr string // substring the error must mention; empty = success
	}{
		{"shorthand", "owner/repo", "https://github.com/owner/repo.git", ""},
		{"shorthand git suffix", "owner/repo.git", "https://github.com/owner/repo.git", ""},
		{"scp style", "git@github.com:owner/repo.git", "https://github.com/owner/repo.git", ""},
		{"scp mixed-case host", "git@GitHub.com:owner/repo.git", "https://github.com/owner/repo.git", ""},
		{"https passthrough", "https://github.com/owner/repo", "https://github.com/owner/repo", ""},
		{"https git suffix passthrough", "https://github.com/owner/repo.git", "https://github.com/owner/repo.git", ""},
		{"https trailing slash passthrough", "https://github.com/owner/repo/", "https://github.com/owner/repo/", ""},
		{"ssh scheme passthrough", "ssh://git@github.com/owner/repo", "ssh://git@github.com/owner/repo", ""},
		{"gitlab https refused", "https://gitlab.com/a/b", "", "invalid repo URL"},
		{"gitlab scp refused", "git@gitlab.com:a/b", "", "invalid repo URL"},
		{"scheme URL no authority", "https:///owner/repo", "", "invalid repo URL"},
		{"deep GitHub URL refused", "https://github.com/o/r/tree/main", "", "invalid repo URL"},
		{"relative dot path refused", "./repo", "", "invalid repo URL"},
		{"relative parent path refused", "../repo", "", "invalid repo URL"},
		{"embedded credentials refused", "https://oauth2:SECRETTOKEN@github.com/owner/repo", "", "embedded credentials"},
		{"unparsable", "not-a-url", "", "invalid repo URL"},
		{"empty", "", "", "invalid repo URL"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := canonicalRepoURL(tc.in)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Errorf("canonicalRepoURL(%q) error = %v, want mention %q", tc.in, err, tc.wantErr)
				}
				if strings.Contains(err.Error(), "SECRETTOKEN") {
					t.Errorf("token must never leak into the error: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("canonicalRepoURL(%q): %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("canonicalRepoURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// ──────────────────────────────────────────────
// gitCloneWorktree (use case)
// ──────────────────────────────────────────────

func TestGitCloneWorktree_exactArgv(t *testing.T) {
	parent, workdir := newWorkspace(t)

	c := stubGitClone(t, nil, nil)
	if err := gitCloneWorktree(context.Background(), "https://github.com/owner/repo", workdir); err != nil {
		t.Fatalf("gitCloneWorktree: %v", err)
	}

	// Clone argv exactly: -c credential.helper, --bare, url, <parent>/.bare.
	wantClone := []string{"git", "-c", "credential.helper=!gh auth git-credential", "clone", "--bare", "https://github.com/owner/repo", filepath.Join(parent, ".bare")}
	if !slices.Equal(c.cloneArgs, wantClone) {
		t.Errorf("clone argv = %v, want %v", c.cloneArgs, wantClone)
	}
	// No --depth / --single-branch: later worktree add of other branches stays possible.
	for _, banned := range []string{"--depth", "--single-branch"} {
		if slices.Contains(c.cloneArgs, banned) {
			t.Errorf("clone argv must not contain %s (full bare clone), got %v", banned, c.cloneArgs)
		}
	}
	// default-branch probe: symbolic-ref HEAD on the bare repo.
	wantSym := []string{"git", "--git-dir", filepath.Join(parent, ".bare"), "symbolic-ref", "HEAD"}
	if !slices.Equal(c.symRefArgs, wantSym) {
		t.Errorf("symbolic-ref argv = %v, want %v", c.symRefArgs, wantSym)
	}
	// worktree add attached to the repo's default branch (not detached).
	wantWT := []string{"git", "--git-dir", filepath.Join(parent, ".bare"), "worktree", "add", workdir, "main"}
	if !slices.Equal(c.worktreeArgs, wantWT) {
		t.Errorf("worktree argv = %v, want %v", c.worktreeArgs, wantWT)
	}
	// Upstream wiring (wireUpstream) so the default branch tracks origin
	// instead of silently diverging (editor pull/push must have a target).
	wantCfg := []string{"git", "--git-dir", filepath.Join(parent, ".bare"), "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"}
	if !slices.Equal(c.configArgs, wantCfg) {
		t.Errorf("config argparse = %v, want %v", c.configArgs, wantCfg)
	}
	wantUR := []string{"git", "--git-dir", filepath.Join(parent, ".bare"), "update-ref", "refs/remotes/origin/main", "main"}
	if !slices.Equal(c.updateRefs, wantUR) {
		t.Errorf("update-ref argv = %v, want %v", c.updateRefs, wantUR)
	}
	wantUS := []string{"git", "--git-dir", filepath.Join(parent, ".bare"), "branch", "--set-upstream-to", "origin/main", "main"}
	if !slices.Equal(c.upstreamArgs, wantUS) {
		t.Errorf("set-upstream argv = %v, want %v", c.upstreamArgs, wantUS)
	}
}

func TestGitCloneWorktree_masterDefaultAttached(t *testing.T) {
	parent, workdir := newWorkspace(t)

	c := stubGitClone(t, nil, nil)
	c.symRefOut = "refs/heads/master\n"
	if err := gitCloneWorktree(context.Background(), "https://github.com/owner/repo", workdir); err != nil {
		t.Fatalf("gitCloneWorktree: %v", err)
	}
	wantWT := []string{"git", "--git-dir", filepath.Join(parent, ".bare"), "worktree", "add", workdir, "master"}
	if !slices.Equal(c.worktreeArgs, wantWT) {
		t.Errorf("master-default worktree argv = %v, want %v", c.worktreeArgs, wantWT)
	}
}

func TestGitCloneWorktree_detachedHeadFallback(t *testing.T) {
	// Exotic edge: the bare HEAD cannot be resolved to a branch name — the
	// clone degrades to the old detached bare-HEAD checkout instead of
	// failing the workspace init.
	parent, workdir := newWorkspace(t)

	c := stubGitClone(t, nil, nil)
	c.symRefOut = ""
	c.symRefErr = errors.New("fatal: ref HEAD is not a symbolic ref")
	if err := gitCloneWorktree(context.Background(), "https://github.com/owner/repo", workdir); err != nil {
		t.Fatalf("gitCloneWorktree: %v", err)
	}
	wantWT := []string{"git", "--git-dir", filepath.Join(parent, ".bare"), "worktree", "add", "--detach", workdir}
	if !slices.Equal(c.worktreeArgs, wantWT) {
		t.Errorf("fallback worktree argv = %v, want %v", c.worktreeArgs, wantWT)
	}
}

func TestGitCloneWorktree_shorthandNormalizedToHTTPS(t *testing.T) {
	_, workdir := newWorkspace(t)

	c := stubGitClone(t, nil, nil)
	if err := gitCloneWorktree(context.Background(), "owner/repo", workdir); err != nil {
		t.Fatalf("gitCloneWorktree: %v", err)
	}
	if !slices.Contains(c.cloneArgs, "https://github.com/owner/repo.git") {
		t.Errorf("shorthand must be normalized to the canonical https URL, got %v", c.cloneArgs)
	}
}

func TestGitCloneWorktree_scpStyleNormalizedToHTTPS(t *testing.T) {
	_, workdir := newWorkspace(t)

	c := stubGitClone(t, nil, nil)
	if err := gitCloneWorktree(context.Background(), "git@github.com:owner/repo.git", workdir); err != nil {
		t.Fatalf("gitCloneWorktree: %v", err)
	}
	if !slices.Contains(c.cloneArgs, "https://github.com/owner/repo.git") {
		t.Errorf("scp-style ssh URL must be normalized to the https URL (gh credential helper is https-only), got %v", c.cloneArgs)
	}
}
