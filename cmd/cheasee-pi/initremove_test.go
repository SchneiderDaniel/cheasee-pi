package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 5: InitRemover adapter tests
// ──────────────────────────────────────────────

func TestInitRemove_NoFile(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()

	if err := r.Remove(workdir); err != nil {
		t.Fatalf("Remove with no .initremove should return nil: %v", err)
	}
}

func TestInitRemove_OnlyComments(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), []byte("# comment\n\n  # another\n"), 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}

	if err := r.Remove(workdir); err != nil {
		t.Fatalf("Remove with only comments should return nil: %v", err)
	}
}

func TestInitRemove_SingleFile(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte("test.md")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	target := filepath.Join(workdir, "test.md")
	if err := os.WriteFile(target, []byte("data"), 0644); err != nil {
		t.Fatalf("write test.md: %v", err)
	}

	// Capture stderr
	stderr := captureStderr(t, func() {
		if err := r.Remove(workdir); err != nil {
			t.Fatalf("Remove failed: %v", err)
		}
	})

	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Error("test.md should be removed")
	}
	if !strings.Contains(stderr, "  ✓ Removed test.md") {
		t.Errorf("expected removal log line, got: %s", stderr)
	}
}

func TestInitRemove_Directory(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte(".github/")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	dir := filepath.Join(workdir, ".github")
	if err := os.MkdirAll(filepath.Join(dir, "workflows"), 0755); err != nil {
		t.Fatalf("create .github dir: %v", err)
	}

	stderr := captureStderr(t, func() {
		if err := r.Remove(workdir); err != nil {
			t.Fatalf("Remove failed: %v", err)
		}
	})

	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error(".github/ should be removed")
	}
	if !strings.Contains(stderr, "  ✓ Removed .github") {
		t.Errorf("expected removal log line, got: %s", stderr)
	}
}

func TestInitRemove_MultiplePatterns(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte("a.md\nb.md")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workdir, "a.md"), []byte("a"), 0644); err != nil {
		t.Fatalf("write a.md: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workdir, "b.md"), []byte("b"), 0644); err != nil {
		t.Fatalf("write b.md: %v", err)
	}

	stderr := captureStderr(t, func() {
		if err := r.Remove(workdir); err != nil {
			t.Fatalf("Remove failed: %v", err)
		}
	})

	if _, err := os.Stat(filepath.Join(workdir, "a.md")); !os.IsNotExist(err) {
		t.Error("a.md should be removed")
	}
	if _, err := os.Stat(filepath.Join(workdir, "b.md")); !os.IsNotExist(err) {
		t.Error("b.md should be removed")
	}
	if !strings.Contains(stderr, "  ✓ Removed a.md") {
		t.Errorf("expected a.md removal log line, got: %s", stderr)
	}
	if !strings.Contains(stderr, "  ✓ Removed b.md") {
		t.Errorf("expected b.md removal log line, got: %s", stderr)
	}
}

func TestInitRemove_GitmodulesProtected(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte(".gitmodules")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workdir, ".gitmodules"), []byte("[submodule \"test\"]\n\tpath = test\n\turl = https://github.com/x/test.git"), 0644); err != nil {
		t.Fatalf("write .gitmodules: %v", err)
	}

	if err := r.Remove(workdir); err != nil {
		t.Fatalf("Remove failed: %v", err)
	}

	if _, err := os.Stat(filepath.Join(workdir, ".gitmodules")); os.IsNotExist(err) {
		t.Error(".gitmodules should be preserved")
	}
}

func TestInitRemove_NonExistentPattern(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte("nonexistent.md")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}

	// Should not error — pattern with zero matches is silently skipped
	if err := r.Remove(workdir); err != nil {
		t.Fatalf("Remove with non-existent pattern should return nil: %v", err)
	}
}

func TestInitRemove_InvalidGlob(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte("unmatched[brackets")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}

	err := r.Remove(workdir)
	if err == nil {
		t.Fatal("expected error for invalid glob syntax")
	}
	if !strings.Contains(err.Error(), "invalid glob pattern") {
		t.Errorf("error should mention invalid glob: %v", err)
	}
}

func TestInitRemove_DeepGlob(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte("**/node_modules/")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	subdir := filepath.Join(workdir, "a", "b", "node_modules")
	if err := os.MkdirAll(subdir, 0755); err != nil {
		t.Fatalf("create nested node_modules: %v", err)
	}
	if err := os.WriteFile(filepath.Join(subdir, "pkg"), []byte("lib"), 0644); err != nil {
		t.Fatalf("write pkg: %v", err)
	}

	stderr := captureStderr(t, func() {
		if err := r.Remove(workdir); err != nil {
			t.Fatalf("Remove failed: %v", err)
		}
	})

	if _, err := os.Stat(subdir); !os.IsNotExist(err) {
		t.Error("nested node_modules/ should be removed")
	}
	if !strings.Contains(stderr, "  ✓ Removed a/b/node_modules") {
		t.Errorf("expected removal log line, got: %s", stderr)
	}
}

func TestInitRemove_TrailingWhitespaceStripped(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte("test.md   ")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workdir, "test.md"), []byte("data"), 0644); err != nil {
		t.Fatalf("write test.md: %v", err)
	}

	if err := r.Remove(workdir); err != nil {
		t.Fatalf("Remove failed: %v", err)
	}

	if _, err := os.Stat(filepath.Join(workdir, "test.md")); !os.IsNotExist(err) {
		t.Error("test.md should be removed")
	}
}

func TestInitRemove_InitremoveIsDirectory(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workdir, ".initremove"), 0755); err != nil {
		t.Fatalf("create .initremove dir: %v", err)
	}

	err := r.Remove(workdir)
	if err == nil {
		t.Fatal("expected error when .initremove is a directory")
	}
	if !strings.Contains(err.Error(), "read .initremove") {
		t.Errorf("error should wrap 'read .initremove': %v", err)
	}
}

func TestRunInit_RemoverCalled(t *testing.T) {
	redirectConfigDir(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	setGitIdentity(t)

	ports := defaultMocks()

	workdir := t.TempDir()
	seedCloneFixture(t, workdir)
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		SubmoduleOps:   &mockSubmoduleOps{},
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
	if err != nil {
		t.Fatalf("full flow with remover failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, "test.md")); !os.IsNotExist(err) {
		t.Error("test.md should be removed by post-clone cleanup")
	}
	if _, err := os.Stat(filepath.Join(workdir, ".github")); !os.IsNotExist(err) {
		t.Error(".github/ should be removed by post-clone cleanup")
	}
	if _, err := os.Stat(filepath.Join(workdir, "README.md")); err != nil {
		t.Errorf("README.md (not listed in .initremove) should survive: %v", err)
	}
}

func TestRunInit_RemoverError(t *testing.T) {
	redirectConfigDir(t)
	stubDockerCheck(t, nil, "24.0.9", nil)

	ports := defaultMocks()

	workdir := t.TempDir()
	os.MkdirAll(filepath.Join(workdir, ".git"), 0755)
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), []byte("unmatched[brackets\n"), 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
	if err == nil {
		t.Fatal("expected error when remover fails")
	}
	if !strings.Contains(err.Error(), "post-clone cleanup") {
		t.Errorf("error should wrap with phase prefix: %v", err)
	}
}

func TestRunInit_RemoverSkipFork(t *testing.T) {
	redirectConfigDir(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	setGitIdentity(t)

	ports := defaultMocks()

	workdir := t.TempDir()
	seedCloneFixture(t, workdir)
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModeSkipFork},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
	if err != nil {
		t.Fatalf("skip-fork flow failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, "test.md")); err != nil {
		t.Errorf("test.md should survive in skip-fork mode (no clone, no cleanup): %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, ".github")); err != nil {
		t.Errorf(".github/ should survive in skip-fork mode: %v", err)
	}
}
