package main

import (
	"os/exec"
	"path/filepath"
	"testing"
)

func TestRepoRoot_worktreeCheckoutReportsOwnToplevel(t *testing.T) {
	main := t.TempDir()
	gitInitDir(t, main)
	// Configure identity so worktree add works (no commits needed, but a
	// worktree requires an existing branch — create one via commit).
	exec.Command("git", "-C", main, "config", "user.email", "t@t.t").Run()
	exec.Command("git", "-C", main, "config", "user.name", "t").Run()
	exec.Command("git", "-C", main, "commit", "--allow-empty", "-q", "-m", "init").Run()

	wt := filepath.Join(t.TempDir(), "wt")
	if out, err := exec.Command("git", "-C", main, "worktree", "add", "-q", wt, "HEAD").CombinedOutput(); err != nil {
		t.Skipf("git worktree add unavailable: %v\n%s", err, out)
	}

	root, _, err := repoRoot(wt)
	if err != nil {
		t.Fatalf("repoRoot: %v", err)
	}
	if root != wt {
		t.Errorf("worktree checkout must resolve to its own toplevel %q, got %q", wt, root)
	}
}
