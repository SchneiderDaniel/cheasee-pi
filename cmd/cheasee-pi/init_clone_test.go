package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// ParseGitHubURL (entity)
// ──────────────────────────────────────────────

func TestParseGitHubURL(t *testing.T) {
	cases := []struct {
		name      string
		url       string
		wantOwner string
		wantRepo  string
	}{
		{"shorthand", "owner/repo", "owner", "repo"},
		{"shorthand git suffix", "owner/repo.git", "owner", "repo"},
		{"https", "https://github.com/owner/repo", "owner", "repo"},
		{"https git suffix", "https://github.com/owner/repo.git", "owner", "repo"},
		{"https trailing slash", "https://github.com/owner/repo/", "owner", "repo"},
		{"ssh colon form", "git@github.com:owner/repo", "owner", "repo"},
		{"ssh colon git suffix", "git@github.com:owner/repo.git", "owner", "repo"},
		{"ssh scheme", "ssh://git@github.com/owner/repo", "owner", "repo"},
		{"invalid no repo", "owner", "", ""},
		{"invalid junk", "not-a-url", "", ""},
		{"invalid empty", "", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			owner, repo := ParseGitHubURL(tc.url)
			if owner != tc.wantOwner || repo != tc.wantRepo {
				t.Errorf("ParseGitHubURL(%q) = (%q, %q), want (%q, %q)", tc.url, owner, repo, tc.wantOwner, tc.wantRepo)
			}
		})
	}
}

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
// gitCloneWorktree (use case)
// ──────────────────────────────────────────────

func TestGitCloneWorktree_exactArgv(t *testing.T) {
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}

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
	// worktree add --detach with NO branch argument (bare HEAD checkout).
	wantWT := []string{"git", "--git-dir", filepath.Join(parent, ".bare"), "worktree", "add", "--detach", workdir}
	if !slices.Equal(c.worktreeArgs, wantWT) {
		t.Errorf("worktree argv = %v, want %v", c.worktreeArgs, wantWT)
	}
}

func TestGitCloneWorktree_shorthandNormalizedToHTTPS(t *testing.T) {
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}

	c := stubGitClone(t, nil, nil)
	if err := gitCloneWorktree(context.Background(), "owner/repo", workdir); err != nil {
		t.Fatalf("gitCloneWorktree: %v", err)
	}
	if !slices.Contains(c.cloneArgs, "https://github.com/owner/repo.git") {
		t.Errorf("shorthand must be normalized to the canonical https URL, got %v", c.cloneArgs)
	}
}

func TestGitCloneWorktree_scpStyleNormalizedToHTTPS(t *testing.T) {
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}

	c := stubGitClone(t, nil, nil)
	if err := gitCloneWorktree(context.Background(), "git@github.com:owner/repo.git", workdir); err != nil {
		t.Fatalf("gitCloneWorktree: %v", err)
	}
	if !slices.Contains(c.cloneArgs, "https://github.com/owner/repo.git") {
		t.Errorf("scp-style ssh URL must be normalized to the https URL (gh credential helper is https-only), got %v", c.cloneArgs)
	}
}

func TestGitCloneWorktree_credentialURLRefused(t *testing.T) {
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}

	c := stubGitClone(t, nil, nil)
	err := gitCloneWorktree(context.Background(), "https://oauth2:SECRETTOKEN@github.com/owner/repo", workdir)
	if err == nil {
		t.Fatal("token-bearing URL must be refused")
	}
	if !strings.Contains(err.Error(), "embedded credentials") {
		t.Errorf("refusal should explain the credential persistence risk, got: %v", err)
	}
	if len(c.cloneArgs) != 0 {
		t.Errorf("no git call may run for a token-bearing URL, got %v", c.cloneArgs)
	}
	// The token itself must never appear in the error.
	if strings.Contains(err.Error(), "SECRETTOKEN") {
		t.Errorf("token leaked into the error: %v", err)
	}
}

func TestGitCloneWorktree_sshGitUserAllowed(t *testing.T) {
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}

	c := stubGitClone(t, nil, nil)
	if err := gitCloneWorktree(context.Background(), "ssh://git@github.com/owner/repo", workdir); err != nil {
		t.Fatalf("ssh://git@ URLs are legitimate and must clone: %v", err)
	}
	if !slices.Contains(c.cloneArgs, "ssh://git@github.com/owner/repo") {
		t.Errorf("ssh URL must be passed through verbatim, got %v", c.cloneArgs)
	}
}

func TestGitCloneWorktree_invalidURL(t *testing.T) {
	workdir := t.TempDir()
	c := stubGitClone(t, nil, nil)
	err := gitCloneWorktree(context.Background(), "not-a-url", workdir)
	if err == nil || !strings.Contains(err.Error(), "invalid repo URL") {
		t.Fatalf("expected invalid repo URL error, got %v", err)
	}
	if len(c.cloneArgs) != 0 {
		t.Errorf("no git call may run for an invalid URL, got %v", c.cloneArgs)
	}
}

func TestGitCloneWorktree_bareCollisionFailsClosed(t *testing.T) {
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	// Non-empty existing .bare → fail-closed collision error.
	if err := os.MkdirAll(filepath.Join(parent, ".bare", "objects"), 0755); err != nil {
		t.Fatal(err)
	}

	c := stubGitClone(t, nil, nil)
	err := gitCloneWorktree(context.Background(), "owner/repo", workdir)
	if err == nil || !strings.Contains(err.Error(), ".bare") || !strings.Contains(err.Error(), "collision") {
		t.Fatalf("expected .bare collision error, got %v", err)
	}
	if len(c.cloneArgs) != 0 {
		t.Errorf("no git call may run on a .bare collision, got %v", c.cloneArgs)
	}
}

func TestGitCloneWorktree_emptyStrayBareDirProceeds(t *testing.T) {
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	// A stray empty .bare (e.g. docker-created) is fine — git clones into it.
	if err := os.MkdirAll(filepath.Join(parent, ".bare"), 0755); err != nil {
		t.Fatal(err)
	}

	c := stubGitClone(t, nil, nil)
	if err := gitCloneWorktree(context.Background(), "owner/repo", workdir); err != nil {
		t.Fatalf("empty stray .bare must not block the clone: %v", err)
	}
	if len(c.cloneArgs) == 0 {
		t.Errorf("expected one clone invocation, got none")
	}
}

func TestGitCloneWorktree_cloneFailureWrappedAndCleaned(t *testing.T) {
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}

	stubGitClone(t, errors.New("connection refused"), nil)
	err := gitCloneWorktree(context.Background(), "https://github.com/owner/repo", workdir)
	if err == nil || !strings.Contains(err.Error(), "bare clone failed") {
		t.Fatalf("clone failure must wrap with 'bare clone failed', got %v", err)
	}
	if !strings.Contains(err.Error(), "connection refused") {
		t.Errorf("wrapped error should carry the git failure, got: %v", err)
	}
	// No half-cloned residue.
	if _, statErr := os.Stat(filepath.Join(parent, ".bare")); !os.IsNotExist(statErr) {
		t.Errorf("failed clone must leave no .bare residue: %v", statErr)
	}
}

func TestGitCloneWorktree_cancelledBetweenCloneAndWorktree(t *testing.T) {
	// A cancelled parent (Ctrl-C) right after the bare clone returns must not
	// proceed to worktree add — the bare clone we created is cleaned up so no
	// half-cloned residue remains.
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cloneRan := false
	saved := runCommandContext
	stubRunCommandContext(t, func(c context.Context, name string, arg ...string) runner {
		if name == "git" && slices.Contains(arg, "clone") {
			cloneRan = true
			cancel() // cancel right after the (stubbed) clone succeeds
			return &mockCmd{}
		}
		return saved(c, name, arg...)
	})

	err := gitCloneWorktree(ctx, "owner/repo", workdir)
	if err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled after clone, got %v", err)
	}
	if !cloneRan {
		t.Fatal("clone stub never ran")
	}
	if _, statErr := os.Stat(filepath.Join(parent, ".bare")); !os.IsNotExist(statErr) {
		t.Errorf("cancelled flow must clean up the bare dir it created, stat err: %v", statErr)
	}
}

func TestGitCloneWorktree_worktreeAddFailureWrapped(t *testing.T) {
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}

	stubGitClone(t, nil, errors.New("fatal: invalid reference: main"))
	err := gitCloneWorktree(context.Background(), "https://github.com/owner/repo", workdir)
	if err == nil || !strings.Contains(err.Error(), "worktree add failed") {
		t.Fatalf("worktree failure must wrap with 'worktree add failed', got %v", err)
	}
	// The bare repo is a valid artifact after a worktree-add failure — kept.
	if _, statErr := os.Stat(filepath.Join(parent, ".bare")); statErr != nil {
		t.Errorf("successful clone should leave .bare even when worktree add fails: %v", statErr)
	}
}

// ──────────────────────────────────────────────
// Real-git adapter/e2e tests (acceptance: verified by execution)
// ──────────────────────────────────────────────
// These exercise the exact CLI sequence gitCloneWorktree builds — bare clone
// + `worktree add --detach` with NO branch argument — against the real git
// binary on temp repos, plus the worktree-fix.sh container path rewrite.

func TestGitCloneWorktree_realGitMainDefault(t *testing.T) {
	src := gitRemoteFixture(t, "main")
	parent := t.TempDir()
	workdir := filepath.Join(parent, "main")

	bareDir := cloneWorktreeLayout(t, src, parent, workdir)

	// HEAD checked out (detached) — no branch arg picked the bare HEAD.
	data, err := os.ReadFile(filepath.Join(workdir, "README.md"))
	if err != nil {
		t.Fatalf("worktree must check out HEAD: %v", err)
	}
	if string(data) != "fixture\n" {
		t.Errorf("worktree content mismatch: %q", data)
	}
	// Worktree .git file points at the sibling bare registration.
	gitFile, err := os.ReadFile(filepath.Join(workdir, ".git"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(gitFile), filepath.Join(".bare", "worktrees", "main")) {
		t.Errorf(".git must reference .bare/worktrees/main, got: %q", gitFile)
	}
	// git worktree list is valid.
	out, err := exec.Command("git", "--git-dir", bareDir, "worktree", "list").CombinedOutput()
	if err != nil {
		t.Fatalf("git worktree list: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), workdir) {
		t.Errorf("worktree list must contain the worktree %s:\n%s", workdir, out)
	}
}

func TestGitCloneWorktree_realGitMasterDefault(t *testing.T) {
	// Regression pin for the old symbolic-ref pitfall: a master-default repo
	// must not hard-fail with "invalid reference: main" — no-branch
	// `worktree add --detach` checks out the bare HEAD on both defaults.
	src := gitRemoteFixture(t, "master")
	parent := t.TempDir()
	workdir := filepath.Join(parent, "main")

	cloneWorktreeLayout(t, src, parent, workdir)

	data, err := os.ReadFile(filepath.Join(workdir, "README.md"))
	if err != nil {
		t.Fatalf("master-default worktree must check out HEAD: %v", err)
	}
	if string(data) != "fixture\n" {
		t.Errorf("master-default worktree content mismatch: %q", data)
	}
}

// ──────────────────────────────────────────────
// removeInitResidue (post-clone failure cleanup)
// ──────────────────────────────────────────────

func TestRemoveInitResidue_realGitLayout(t *testing.T) {
	// Adapter: on a real git worktree layout, removeInitResidue removes the
	// worktree dir (incl. its .git file) plus the sibling .bare.
	src := gitRemoteFixture(t, "main")
	parent := t.TempDir()
	workdir := filepath.Join(parent, "main")
	bareDir := cloneWorktreeLayout(t, src, parent, workdir)

	removeInitResidue(workdir)

	if _, err := os.Stat(workdir); !os.IsNotExist(err) {
		t.Errorf("removeInitResidue must remove the worktree dir: %v", err)
	}
	if _, err := os.Stat(bareDir); !os.IsNotExist(err) {
		t.Errorf("removeInitResidue must remove the sibling .bare: %v", err)
	}
}

func TestRemoveInitResidue_missingIsNoOp(t *testing.T) {
	// Best-effort by contract: nothing was ever cloned → silent no-op, no
	// error, no panic, parent untouched.
	parent := t.TempDir()
	removeInitResidue(filepath.Join(parent, "ws"))
	if _, err := os.Stat(parent); err != nil {
		t.Errorf("parent must be untouched: %v", err)
	}
}

func TestGitCloneWorktree_e2eWorktreeFix(t *testing.T) {
	// Acceptance "verified by execution": after clone+scaffold+gitignore
	// append, running worktree-fix.sh against the fixture layout (via its
	// WORKSPACE_BASE param) yields a valid, clean, locked worktree — the same
	// sequence the container entrypoint runs at every start.
	src := gitRemoteFixture(t, "main")
	parent := t.TempDir()
	workdir := filepath.Join(parent, "main")

	bareDir := cloneWorktreeLayout(t, src, parent, workdir)

	// Scaffold what init scaffolds: the dedicated settings file plus the
	// idempotent .gitignore append (real function, not a fixture shortcut).
	if err := os.WriteFile(filepath.Join(workdir, "cheasee-settings.json"), []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := gitIgnoreCheaseeSettings(workdir); err != nil {
		t.Fatalf("gitignore append: %v", err)
	}

	// Simulate the container: the .git gitdir points at a host path that does
	// NOT exist inside the container (worktree-fix's rewrite trigger), like
	// the node fixture suite does.
	hostPrefix := "/home/user/git"
	if err := os.WriteFile(filepath.Join(workdir, ".git"), []byte("gitdir: "+hostPrefix+"/.bare/worktrees/main\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(bareDir, "worktrees", "main"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bareDir, "worktrees", "main", "gitdir"), []byte(hostPrefix+"/main/.git\n"), 0644); err != nil {
		t.Fatal(err)
	}

	// Run worktree-fix.sh against the fixture (WORKSPACE_BASE = parent).
	fixScript := filepath.Join("embedded", "docker", "lib", "worktree-fix.sh")
	cmd := exec.Command("bash", "-c", `source "$1" && unbreak_worktrees "$2"`, "bash", fixScript, parent)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("worktree-fix failed: %v\n%s", err, out)
	}

	// Step 1: .git rewritten to a relative path.
	gitFile, err := os.ReadFile(filepath.Join(workdir, ".git"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(gitFile), "gitdir: ../.bare/worktrees/main") {
		t.Errorf("worktree-fix must rewrite the gitdir to relative, got: %q", gitFile)
	}
	// Step 4: worktree locked (protected against future pruning).
	if _, err := os.Stat(filepath.Join(bareDir, "worktrees", "main", "locked")); err != nil {
		t.Errorf("worktree must be locked after worktree-fix: %v", err)
	}

	// git worktree list is valid from the fixed worktree (the registration is
	// listed with its relative path — git resolves it via the gitdir file).
	out, err := exec.Command("git", "-C", workdir, "worktree", "list").CombinedOutput()
	if err != nil {
		t.Fatalf("git worktree list after fix: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "(detached HEAD)") || !strings.Contains(string(out), "locked") {
		t.Errorf("worktree list must show the fixed, locked worktree:\n%s", out)
	}
	// git status --porcelain shows no untracked cheasee-settings.json (the
	// appended .gitignore hides it; the append itself shows as a modification
	// until committed — machine-local settings never pollute the index).
	status, err := exec.Command("git", "-C", workdir, "status", "--porcelain").CombinedOutput()
	if err != nil {
		t.Fatalf("git status after fix: %v\n%s", err, status)
	}
	if strings.Contains(string(status), "cheasee-settings.json") {
		t.Errorf("cheasee-settings.json must never show as untracked, got: %q", status)
	}
}
