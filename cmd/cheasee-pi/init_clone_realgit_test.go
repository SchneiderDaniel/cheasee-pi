package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Real-git adapter/e2e tests (acceptance: verified by execution)
// ──────────────────────────────────────────────
// These exercise the exact CLI sequence gitCloneWorktree builds — bare clone
// + default-branch probe + `worktree add <branch>` (attached, not detached)
// — against the real git binary on temp repos, plus the worktree-fix.sh
// container path rewrite.

func TestGitCloneWorktree_realGitMainDefault(t *testing.T) {
	src := gitRemoteFixture(t, "main")
	parent := t.TempDir()
	workdir := filepath.Join(parent, "main")

	bareDir := cloneWorktreeLayout(t, src, parent, workdir)

	// Attached to the named default branch, not a detached HEAD — the pi
	// footer shows the branch ("detached [main]" stays away).
	out, err := exec.Command("git", "-C", workdir, "branch", "--show-current").CombinedOutput()
	if err != nil {
		t.Fatalf("git branch --show-current: %v", err)
	}
	if strings.TrimSpace(string(out)) != "main" {
		t.Errorf("worktree must be attached to branch 'main', got %q", strings.TrimSpace(string(out)))
	}
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
	out, err = exec.Command("git", "--git-dir", bareDir, "worktree", "list").CombinedOutput()
	if err != nil {
		t.Fatalf("git worktree list: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), workdir) {
		t.Errorf("worktree list must contain the worktree %s:\n%s", workdir, out)
	}
}

func TestGitCloneWorktree_realGitMasterDefault(t *testing.T) {
	src := gitRemoteFixture(t, "master")
	parent := t.TempDir()
	workdir := filepath.Join(parent, "main")

	bareDir := cloneWorktreeLayout(t, src, parent, workdir)

	// Attached to 'master'; the old symbolic-ref pitfall (hard-fail
	// "invalid reference: main") is gone because the branch name comes from
	// the bare HEAD, never an assumption.
	out, err := exec.Command("git", "-C", workdir, "branch", "--show-current").CombinedOutput()
	if err != nil {
		t.Fatalf("git branch --show-current: %v", err)
	}
	if strings.TrimSpace(string(out)) != "master" {
		t.Errorf("master-default worktree must be attached to 'master', got %q", strings.TrimSpace(string(out)))
	}
	data, err := os.ReadFile(filepath.Join(workdir, "README.md"))
	if err != nil {
		t.Fatalf("master-default worktree must check out HEAD: %v", err)
	}
	if string(data) != "fixture\n" {
		t.Errorf("master-default worktree content mismatch: %q", data)
	}
	// git worktree list is valid on the master-default layout too.
	out, err = exec.Command("git", "--git-dir", bareDir, "worktree", "list").CombinedOutput()
	if err != nil {
		t.Fatalf("git worktree list: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), workdir) {
		t.Errorf("worktree list must contain the worktree %s:\n%s", workdir, out)
	}
}

func TestGitCloneWorktree_realGitTracksOrigin(t *testing.T) {
	// Acceptance: after the CLI layout, the default-branch worktree tracks
	// origin (upstream resolves, status shows ahead/behind) — a bare clone
	// gives none of that on its own, which previously left editor pull/push
	// targetless and let the branch diverge in silence.
	src := gitRemoteFixture(t, "main")
	parent := t.TempDir()
	workdir := filepath.Join(parent, "main")
	cloneWorktreeLayout(t, src, parent, workdir)

	out, err := exec.Command("git", "-C", workdir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").CombinedOutput()
	if err != nil {
		t.Fatalf("rev-parse @{u}: %v\n%s", err, out)
	}
	if strings.TrimSpace(string(out)) != "origin/main" {
		t.Errorf("worktree must track origin/main, got %q", strings.TrimSpace(string(out)))
	}
	out, err = exec.Command("git", "-C", workdir, "status", "-sb").CombinedOutput()
	if err != nil {
		t.Fatalf("git status: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "...origin/main") {
		t.Errorf("status must show the tracking relationship, got: %q", strings.TrimSpace(string(out)))
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
	if !strings.Contains(string(out), "main") || !strings.Contains(string(out), "locked") {
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
