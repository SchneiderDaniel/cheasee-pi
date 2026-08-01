package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
)

// initRemover handles post-clone cleanup by reading .initremove
// and deleting listed files/directories.
type initRemover struct{}

// NewInitRemover creates a new initRemover adapter.
func NewInitRemover() *initRemover {
	return &initRemover{}
}

// Remove reads .initremove at workdir root, expands gitignore-style patterns,
// and removes matching files/directories. Returns nil if no .initremove file exists.
func (r *initRemover) Remove(workdir string) error {
	path := filepath.Join(workdir, ".initremove")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read .initremove: %w", err)
	}

	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		// Validate glob syntax
		if !doublestar.ValidatePattern(line) {
			return fmt.Errorf("invalid glob pattern in .initremove: %q", line)
		}

		// Use Glob to find matching files
		// The pattern is relative to workdir
		fsys := os.DirFS(workdir)
		matches, err := doublestar.Glob(fsys, line)
		if err != nil {
			return fmt.Errorf("glob pattern %q: %w", line, err)
		}

		for _, match := range matches {
			// Protect .gitmodules
			if match == ".gitmodules" {
				continue
			}

			fullPath := filepath.Join(workdir, match)

			// Stat the path — ENOENT = skip silently (no error)
			if _, err := os.Stat(fullPath); err != nil {
				if os.IsNotExist(err) {
					continue
				}
				return fmt.Errorf("stat %q: %w", match, err)
			}

			if err := os.RemoveAll(fullPath); err != nil {
				return fmt.Errorf("remove %q: %w", match, err)
			}
			fmt.Fprintf(os.Stderr, "  ✓ Removed %s\n", match)
		}
	}

	return nil
}
