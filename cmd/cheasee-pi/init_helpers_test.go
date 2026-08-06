package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func authJSONExists(t *testing.T) bool {
	t.Helper()
	cfg := &fileRepository{}
	p, err := cfg.Path()
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

func loadAuthJSON(t *testing.T) *Auth {
	t.Helper()
	cfg := &fileRepository{}
	auth, err := cfg.Load(context.Background())
	if err != nil {
		t.Fatalf("load auth.json: %v", err)
	}
	return auth
}

func seedCloneFixture(t *testing.T, workdir string) {
	t.Helper()
	os.MkdirAll(filepath.Join(workdir, ".git"), 0755)
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), []byte("test.md\n.github/\n"), 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workdir, "test.md"), []byte("data"), 0644); err != nil {
		t.Fatalf("write test.md: %v", err)
	}
	os.MkdirAll(filepath.Join(workdir, ".github", "workflows"), 0755)
	if err := os.WriteFile(filepath.Join(workdir, "README.md"), []byte("# repo\n"), 0644); err != nil {
		t.Fatalf("write README.md: %v", err)
	}
}
