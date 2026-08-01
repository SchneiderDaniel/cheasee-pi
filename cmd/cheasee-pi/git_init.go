package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// gitInit runs git init in the given workdir. It is a no-op if .git already
// exists. It respects context cancellation.
func gitInit(ctx context.Context, workdir string) error {
	// Idempotent: skip if .git already exists.
	if _, err := os.Stat(filepath.Join(workdir, ".git")); err == nil {
		return nil
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	cmd := runCommandContext(ctx, "git", "init", workdir)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git init %s: %s: %w", workdir, string(output), err)
	}
	return nil
}
