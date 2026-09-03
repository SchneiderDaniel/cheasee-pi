package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func assertFacts(t *testing.T, workdir string, wantPresent, wantEmpty bool, wantFirst string) {
	t.Helper()
	present, empty, first, err := workspaceFacts(workdir)
	if err != nil {
		t.Fatalf("workspaceFacts(%q): %v", workdir, err)
	}
	if present != wantPresent || empty != wantEmpty || first != wantFirst {
		t.Errorf("workspaceFacts(%q) = (%v, %v, %q); want (%v, %v, %q)",
			workdir, present, empty, first, wantPresent, wantEmpty, wantFirst)
	}
}

func TestWorkspaceFacts_empty(t *testing.T) {
	assertFacts(t, t.TempDir(), false, true, "")
}

func TestWorkspaceFacts_dsStoreOnly(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".DS_Store"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	// .DS_Store tolerance is owned by the shared predicate, not the callers.
	assertFacts(t, dir, false, true, "")
}

func TestWorkspaceFacts_settingsPresent(t *testing.T) {
	dir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, dir, `{}`)
	// Marker short-circuits: empty probe skipped, so empty=false even though
	// the folder holds only the marker.
	assertFacts(t, dir, true, false, "")
}

func TestWorkspaceFacts_settingsPresentSkipsEmptyProbe(t *testing.T) {
	dir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, dir, `{}`)
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	assertFacts(t, dir, true, false, "")
}

func TestWorkspaceFacts_singleFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	assertFacts(t, dir, false, false, "file.txt")
}

func TestWorkspaceFacts_firstEntryLexicographic(t *testing.T) {
	// os.ReadDir sorts by filename, so firstEntry is deterministic: b.txt is
	// written first but a.txt sorts ahead; .DS_Store is skipped.
	dir := t.TempDir()
	for _, name := range []string{"b.txt", ".DS_Store", "a.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	assertFacts(t, dir, false, false, "a.txt")
}

func TestWorkspaceFacts_statErrorPropagates(t *testing.T) {
	// workdir beneath a regular file: the marker stat hits ENOTDIR (or,
	// where the platform reports NotExist first, the ReadDir on the same
	// broken path still errors) — either way the loose err != nil holds.
	dir := t.TempDir()
	broken := filepath.Join(dir, "somefile.txt", "sub")
	if err := os.WriteFile(filepath.Join(dir, "somefile.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := workspaceFacts(broken); err == nil {
		t.Errorf("workspaceFacts(%q): expected error, got nil", broken)
	}
}

func TestWorkspaceFacts_nonexistent(t *testing.T) {
	// ReadDir ENOENT propagates.
	if _, _, _, err := workspaceFacts(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Error("workspaceFacts(missing): expected error, got nil")
	}
}
