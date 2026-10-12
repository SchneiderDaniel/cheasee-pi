package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestGitCloneWorktree_credentialURLRefused(t *testing.T) {
	_, workdir := newWorkspace(t)

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
	_, workdir := newWorkspace(t)

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

func TestGitCloneWorktree_gitlabURLRefused(t *testing.T) {
	// Fail-fast tightening: a non-GitHub remote URL was previously accepted
	// by the three-way split ("https:" owner garbage) and died late inside
	// git; now it is refused before any git invocation runs.
	workdir := t.TempDir()
	c := stubGitClone(t, nil, nil)
	err := gitCloneWorktree(context.Background(), "https://gitlab.com/a/b", workdir)
	if err == nil || !strings.Contains(err.Error(), "invalid repo URL") {
		t.Fatalf("expected invalid repo URL error for a gitlab URL, got %v", err)
	}
	if len(c.cloneArgs) != 0 {
		t.Errorf("no git call may run for a gitlab URL, got %v", c.cloneArgs)
	}
}

func TestGitCloneWorktree_schemeURLWithoutAuthorityRefused(t *testing.T) {
	// Fail-closed regression (audit): a scheme URL with no authority
	// (https:///owner/repo) must never reach git as if it were shorthand.
	workdir := t.TempDir()
	c := stubGitClone(t, nil, nil)
	err := gitCloneWorktree(context.Background(), "https:///owner/repo", workdir)
	if err == nil || !strings.Contains(err.Error(), "invalid repo URL") {
		t.Fatalf("expected invalid repo URL error for an authority-less scheme URL, got %v", err)
	}
	if len(c.cloneArgs) != 0 {
		t.Errorf("no git call may run for an authority-less scheme URL, got %v", c.cloneArgs)
	}
}

func TestGitCloneWorktree_bareCollisionFailsClosed(t *testing.T) {
	parent, workdir := newWorkspace(t)
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
	parent, workdir := newWorkspace(t)
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
	parent, workdir := newWorkspace(t)

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
	parent, workdir := newWorkspace(t)

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
	parent, workdir := newWorkspace(t)

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
