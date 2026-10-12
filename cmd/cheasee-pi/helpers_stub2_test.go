package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStubInitFlow(t *testing.T) {
	c := stubInitFlow(t)
	if c == nil {
		t.Fatal("stubInitFlow must return a clone capture")
	}
	ctx := context.Background()

	if out, err := runCommandContext(ctx, "docker", "version").Output(); err != nil || string(out) != "24.0.9" {
		t.Errorf("docker version = %q, %v; want 24.0.9", out, err)
	}
	if err := runCommandContext(ctx, "docker", "info").Run(); err != nil {
		t.Errorf("docker info must succeed: %v", err)
	}

	// Detached worktree add keeps the target last, matching the real argv the
	// stub materializes (the branch-form bare-HEAD probe fails against the fake
	// .bare, so the init flow lands here).
	parent := t.TempDir()
	bare := filepath.Join(parent, ".bare")
	if err := runCommandContext(ctx, "git", "clone", "--bare", "https://example.com/o/r", bare).Run(); err != nil {
		t.Fatalf("stubbed git clone: %v", err)
	}
	if len(c.cloneArgs) != 1 || c.cloneArgs[0][len(c.cloneArgs[0])-1] != bare {
		t.Errorf("clone argv not captured: %v", c.cloneArgs)
	}
	if _, err := os.Stat(bare); err != nil {
		t.Errorf("bare dir must be materialized: %v", err)
	}

	wt := filepath.Join(parent, "ws")
	if err := runCommandContext(ctx, "git", "--git-dir", bare, "worktree", "add", "--detach", wt).Run(); err != nil {
		t.Fatalf("stubbed worktree add: %v", err)
	}
	if len(c.worktreeAdd) != 1 {
		t.Errorf("worktree argv not captured: %v", c.worktreeAdd)
	}
	if b, err := os.ReadFile(filepath.Join(wt, ".git")); err != nil || string(b) != "gitdir: ../.bare/worktrees/main\n" {
		t.Errorf("worktree .git = %q, %v", b, err)
	}

	// Non-docker/non-git falls through to the real seam: the hermetic identity
	// read still resolves.
	if out, err := runCommandContext(ctx, "git", "config", "--global", "user.name").Output(); err != nil || strings.TrimSpace(string(out)) != "Test User" {
		t.Errorf("git identity read = %q, %v; want Test User", out, err)
	}
}
