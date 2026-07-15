package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// ──────────────────────────────────────────────
// Port: GitInitializer
// ──────────────────────────────────────────────

// GitInitializer creates a git repository in the given working directory.
// It is idempotent: calling Init on a directory that already has a .git
// directory returns nil (no error).
type GitInitializer interface {
	Init(ctx context.Context, workdir string) error
}

// ──────────────────────────────────────────────
// Adapter: osGitInitializer
// ──────────────────────────────────────────────

type osGitInitializer struct{}

// NewGitInitializer creates a GitInitializer that shells out to git init.
func NewGitInitializer() GitInitializer {
	return &osGitInitializer{}
}

// Init runs git init in the given workdir. It is a no-op if .git already
// exists. The adapter respects context cancellation.
func (g *osGitInitializer) Init(ctx context.Context, workdir string) error {
	// Idempotent: skip if .git already exists.
	if _, err := os.Stat(filepath.Join(workdir, ".git")); err == nil {
		return nil
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	cmd := exec.CommandContext(ctx, "git", "init", workdir)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git init %s: %s: %w", workdir, string(output), err)
	}
	return nil
}
