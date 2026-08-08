package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// runInitClone characterization tests: fork+clone phase of runInit.
// Same body as the pre-rename original; the rename is purely cosmetic.

func TestInitClone_InvalidURL(t *testing.T) {
	err := runInitClone(context.Background(), FakeGitHubToken, "not-a-url", t.TempDir())
	if err == nil {
		t.Fatal("expected error for invalid clone URL")
	}
	if !strings.Contains(err.Error(), "invalid clone URL") {
		t.Errorf("error should mention invalid clone URL: %v", err)
	}
}

func TestInitClone_SkipsWhenGitExists(t *testing.T) {
	workdir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workdir, ".git"), 0755); err != nil {
		t.Fatal(err)
	}

	called := false
	savedRun := runCommandContext
	runCommandContext = func(_ context.Context, _ string, _ ...string) runner {
		called = true
		return &mockCmd{}
	}
	defer func() { runCommandContext = savedRun }()

	err := runInitClone(context.Background(), FakeGitHubToken, "https://github.com/owner/repo.git", workdir)
	if err != nil {
		t.Fatalf("expected skip, got error: %v", err)
	}
	if called {
		t.Error("clone seam should not be called when .git exists")
	}
}

func TestInitClone_RefusesNonEmptyWithoutGit(t *testing.T) {
	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	err := runInitClone(context.Background(), FakeGitHubToken, "https://github.com/owner/repo.git", workdir)
	if err == nil {
		t.Fatal("expected error for non-empty dir without .git")
	}
	if !strings.Contains(err.Error(), "not empty") {
		t.Errorf("error should mention non-empty dir: %v", err)
	}
}

func TestInitClone_ClonesViaGitCLI(t *testing.T) {
	var cloneURL string
	var cloneDir string
	savedRun := runCommandContext
	runCommandContext = func(_ context.Context, _ string, arg ...string) runner {
		if len(arg) > 0 && arg[0] == "clone" {
			cloneURL = arg[2]
			cloneDir = arg[3]
		}
		return &mockCmd{}
	}
	defer func() { runCommandContext = savedRun }()

	workdir := filepath.Join(t.TempDir(), "repo")
	err := runInitClone(context.Background(), FakeGitHubToken, "https://github.com/owner/repo.git", workdir)
	if err != nil {
		t.Fatalf("runInitClone failed: %v", err)
	}
	if cloneURL != "https://oauth2:"+FakeGitHubToken+"@github.com/owner/repo.git" {
		t.Errorf("expected tokenized clone URL, got %q", cloneURL)
	}
	if !strings.HasSuffix(cloneDir, ".bare") {
		t.Errorf("expected bare clone dest ending in .bare, got %q", cloneDir)
	}
}

func TestInitClone_CloneErrorWraps(t *testing.T) {
	savedRun := runCommandContext
	runCommandContext = func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{combinedFn: func() ([]byte, error) { return []byte("fatal: repo not found"), os.ErrNotExist }}
	}
	defer func() { runCommandContext = savedRun }()

	err := runInitClone(context.Background(), FakeGitHubToken, "https://github.com/owner/repo.git", filepath.Join(t.TempDir(), "repo"))
	if err == nil {
		t.Fatal("expected error when clone fails")
	}
	if !strings.Contains(err.Error(), "clone fork") {
		t.Errorf("error should wrap with 'clone fork': %v", err)
	}
}
