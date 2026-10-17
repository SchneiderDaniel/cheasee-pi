package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// copyCodeflowDir extracts the embedded codeflow directory — server.py plus the
// sibling modules it imports (codeflow_config/rewrites/store/run/tree) and
// fp-filter.js — into dir. The shim is a thin facade over those modules, so a
// harness that materialises only server.py would fail to import them.
func copyCodeflowDir(t *testing.T, dir string) {
	t.Helper()
	const root = "embedded/docker/codeflow"
	err := fs.WalkDir(embeddedFS, root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		dest := filepath.Join(dir, rel)
		if d.IsDir() {
			return os.MkdirAll(dest, 0755)
		}
		data, readErr := fs.ReadFile(embeddedFS, path)
		if readErr != nil {
			return readErr
		}
		return os.WriteFile(dest, data, 0644)
	})
	if err != nil {
		t.Fatalf("extract embedded codeflow dir into %s: %v", dir, err)
	}
}

// embeddedCodeflowSources concatenates every embedded codeflow Python module,
// so static source checks cover the whole package, not just the server.py
// facade.
func embeddedCodeflowSources(t *testing.T) string {
	t.Helper()
	const root = "embedded/docker/codeflow"
	var b strings.Builder
	err := fs.WalkDir(embeddedFS, root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() || !strings.HasSuffix(path, ".py") {
			return nil
		}
		data, readErr := fs.ReadFile(embeddedFS, path)
		if readErr != nil {
			return readErr
		}
		b.Write(data)
		b.WriteByte('\n')
		return nil
	})
	if err != nil {
		t.Fatalf("read embedded codeflow sources: %v", err)
	}
	return b.String()
}
