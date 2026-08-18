package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// ensurePiSkeleton (filesystem adapter)
// ──────────────────────────────────────────────

func TestEnsurePiSkeleton_freshWorktree(t *testing.T) {
	workdir := t.TempDir()
	if err := ensurePiSkeleton(workdir); err != nil {
		t.Fatalf("ensurePiSkeleton: %v", err)
	}

	// Exactly the six skeleton dirs — names must match the exact relative
	// paths the embedded pi template references (sessionDir .pi/sessions,
	// skills/prompts/extensions arrays).
	for _, dir := range piSkeletonDirs {
		fi, err := os.Stat(filepath.Join(workdir, ".pi", dir))
		if err != nil {
			t.Errorf(".pi/%s missing: %v", dir, err)
			continue
		}
		if !fi.IsDir() {
			t.Errorf(".pi/%s must be a directory", dir)
		}
	}
	entries, err := os.ReadDir(filepath.Join(workdir, ".pi"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != len(piSkeletonDirs) {
		t.Errorf(".pi contains %d entries, want exactly %d: %v", len(entries), len(piSkeletonDirs), entries)
	}

	// pi owns settings.json (never scaffolded).
	if _, err := os.Stat(filepath.Join(workdir, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Errorf("ensurePiSkeleton must not create .pi/settings.json: %v", err)
	}
}

func TestEnsurePiSkeleton_existingTreeUntouched(t *testing.T) {
	// A repo-committed .pi tree (cheasee-pi itself and earendil-works/pi
	// commit .pi/settings.json) must never be modified — MkdirAll on existing
	// dirs is a no-op.
	workdir := t.TempDir()
	pi := filepath.Join(workdir, ".pi")
	settingsContent := []byte(`{"defaultProvider": "openai"}`)
	skillContent := []byte("# foo\n")
	if err := os.MkdirAll(filepath.Join(pi, "skills"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pi, "settings.json"), settingsContent, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pi, "skills", "foo.md"), skillContent, 0644); err != nil {
		t.Fatal(err)
	}

	if err := ensurePiSkeleton(workdir); err != nil {
		t.Fatalf("ensurePiSkeleton: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(pi, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(settingsContent) {
		t.Error("pre-existing .pi/settings.json must be byte-identical")
	}
	got, err = os.ReadFile(filepath.Join(pi, "skills", "foo.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(skillContent) {
		t.Error("pre-existing .pi/skills/foo.md must be byte-identical")
	}
}

func TestEnsurePiSkeleton_partialTreeFillsMissing(t *testing.T) {
	workdir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workdir, ".pi", "skills"), 0755); err != nil {
		t.Fatal(err)
	}

	if err := ensurePiSkeleton(workdir); err != nil {
		t.Fatalf("ensurePiSkeleton: %v", err)
	}
	for _, dir := range piSkeletonDirs {
		if _, err := os.Stat(filepath.Join(workdir, ".pi", dir)); err != nil {
			t.Errorf(".pi/%s missing after partial fill: %v", dir, err)
		}
	}
}

func TestEnsurePiSkeleton_piIsFileErrors(t *testing.T) {
	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, ".pi"), []byte(""), 0644); err != nil {
		t.Fatal(err)
	}

	err := ensurePiSkeleton(workdir)
	if err == nil {
		t.Fatal("expected error when .pi is a regular file")
	}
	if !strings.Contains(err.Error(), ".pi") {
		t.Errorf("error must reference .pi: %v", err)
	}
}
