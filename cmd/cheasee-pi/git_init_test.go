package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitInitializer_Init(t *testing.T) {
	workdir := t.TempDir()

	if err := gitInit(context.Background(), workdir); err != nil {
		t.Fatalf("gitInit failed: %v", err)
	}

	// .git directory should exist
	gitDir := filepath.Join(workdir, ".git")
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		t.Error("expected .git directory to exist after gitInit")
	}
}

func TestGitInitializer_Idempotent(t *testing.T) {
	workdir := t.TempDir()

	// First call: create .git
	if err := gitInit(context.Background(), workdir); err != nil {
		t.Fatalf("first gitInit failed: %v", err)
	}

	// Second call: should no-op
	if err := gitInit(context.Background(), workdir); err != nil {
		t.Fatalf("second gitInit should not error: %v", err)
	}

	// .git still exists
	gitDir := filepath.Join(workdir, ".git")
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		t.Error("expected .git directory to exist after idempotent gitInit")
	}
}

func TestGitInitializer_NonExistentWorkdir(t *testing.T) {
	// Use null byte in path — forces EINVAL from git init
	err := gitInit(context.Background(), "/nonexistent\x00path")
	if err == nil {
		t.Fatal("expected error for invalid path with null byte")
	}
	if !strings.Contains(err.Error(), "git init") {
		t.Errorf("error should mention 'git init': %v", err)
	}
}

func TestGitInitializer_ContextCancelled(t *testing.T) {
	workdir := t.TempDir()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled

	// Seam must not be touched for a pre-cancelled ctx.
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		t.Errorf("runCommandContext should not be invoked with cancelled ctx")
		return &mockCmd{}
	})

	err := gitInit(ctx, workdir)
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
	if !strings.Contains(err.Error(), "context") {
		t.Errorf("error should mention context: %v", err)
	}
}

func TestGitInit_SeamArgsCaptured(t *testing.T) {
	var captured []string
	stubRunCommandContext(t, func(_ context.Context, _ string, arg ...string) runner {
		captured = arg
		return &mockCmd{}
	})

	workdir := t.TempDir()
	if err := gitInit(context.Background(), workdir); err != nil {
		t.Fatalf("gitInit failed: %v", err)
	}
	if strings.Join(captured, " ") != "init "+workdir {
		t.Errorf("expected (git, init, workdir), got %v", captured)
	}
}

func TestGitInit_ErrorWrapsOutput(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{combinedFn: func() ([]byte, error) {
			return []byte("fatal: Invalid path"), fmt.Errorf("exit status 128")
		}}
	})

	err := gitInit(context.Background(), t.TempDir())
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "git init") {
		t.Errorf("error should mention git init: %v", err)
	}
	if !strings.Contains(err.Error(), "Invalid path") {
		t.Errorf("error should include command output: %v", err)
	}
}
