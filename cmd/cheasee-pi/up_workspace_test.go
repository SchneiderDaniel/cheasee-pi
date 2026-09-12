package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// Workspace gate coverage: classifyWorkspace, resolveStartWorkspace,
// resolveWorkspaceParent. Moved verbatim from up_test.go (2 tests) and
// up_flow_test.go (4 tests + 3 resolve tests + the parent fixture).
// ──────────────────────────────────────────────

func TestClassifyWorkspace_settingsBeatsNonEmpty(t *testing.T) {
	// Marker precedes refuse: an initialized workspace with stray files is
	// WorkspaceInitialized, never WorkspaceRefuse.
	dir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, dir, `{}`)
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	state, err := classifyWorkspace(dir)
	if err != nil {
		t.Fatalf("classifyWorkspace: %v", err)
	}
	if state != WorkspaceInitialized {
		t.Errorf("settings + stray files → WorkspaceInitialized, got %v", state)
	}
}

func TestClassifyWorkspace_brokenPathError(t *testing.T) {
	// A workdir that can't be inspected surfaces the workdir-wrapping error.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "somefile.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	broken := filepath.Join(dir, "somefile.txt", "sub")
	_, err := classifyWorkspace(broken)
	if err == nil || !strings.Contains(err.Error(), "inspect workspace") || !strings.Contains(err.Error(), broken) {
		t.Fatalf("broken workdir must surface inspect-workspace error naming the dir, got: %v", err)
	}
}
func TestClassifyWorkspace_empty(t *testing.T) {
	state, err := classifyWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("classifyWorkspace: %v", err)
	}
	if state != WorkspaceEmpty {
		t.Errorf("empty dir → WorkspaceEmpty, got %v", state)
	}
}

func TestClassifyWorkspace_dsStoreOnly(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".DS_Store"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	state, err := classifyWorkspace(dir)
	if err != nil {
		t.Fatalf("classifyWorkspace: %v", err)
	}
	if state != WorkspaceEmpty {
		t.Errorf(".DS_Store-only dir → WorkspaceEmpty, got %v", state)
	}
}

func TestClassifyWorkspace_initialized(t *testing.T) {
	dir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, dir, `{}`)
	state, err := classifyWorkspace(dir)
	if err != nil {
		t.Fatalf("classifyWorkspace: %v", err)
	}
	if state != WorkspaceInitialized {
		t.Errorf("cheasee-settings.json present → WorkspaceInitialized, got %v", state)
	}
}

func TestClassifyWorkspace_nonEmptyRefuse(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	state, err := classifyWorkspace(dir)
	if err != nil {
		t.Fatalf("classifyWorkspace: %v", err)
	}
	if state != WorkspaceRefuse {
		t.Errorf("non-empty w/o settings → WorkspaceRefuse, got %v", state)
	}
}

func TestResolveStartWorkspace_fromSubdir(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	if err := os.MkdirAll(filepath.Join(root, "sub", "dir"), 0755); err != nil {
		t.Fatal(err)
	}
	testutil.WriteCheaseeSettingsFile(t, root, `{}`)

	got, state, err := resolveStartWorkspace(filepath.Join(root, "sub", "dir"))
	if err != nil {
		t.Fatalf("resolveStartWorkspace: %v", err)
	}
	if got != root || state != WorkspaceInitialized {
		t.Errorf("resolveStartWorkspace(subdir) = %q, %v; want %q, WorkspaceInitialized", got, state, root)
	}
}

func TestResolveStartWorkspace_onEmptyDir(t *testing.T) {
	root, state, err := resolveStartWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("resolveStartWorkspace: %v", err)
	}
	if root != "" || state != WorkspaceEmpty {
		t.Errorf("no ancestor with cheasee-settings.json → (\"\", WorkspaceEmpty), got (%q, %v)", root, state)
	}
}

// workspaceParentFixture builds the cheasee-pi parent layout: a parent folder
// with a sibling .bare and one worktree leaf holding cheasee-settings.json
// (the exact layout init leaves behind).
func workspaceParentFixture(t *testing.T) (parent, leaf string) {
	t.Helper()
	parent = t.TempDir()
	leaf = filepath.Join(parent, "main")
	if err := os.MkdirAll(filepath.Join(parent, ".bare"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(leaf, 0755); err != nil {
		t.Fatal(err)
	}
	testutil.WriteCheaseeSettingsFile(t, leaf, `{}`)
	return parent, leaf
}

func TestResolveWorkspaceParent_fromParent(t *testing.T) {
	parent, leaf := workspaceParentFixture(t)
	got, ok := resolveWorkspaceParent(parent)
	if !ok || got != leaf {
		t.Errorf("resolveWorkspaceParent(parent) = %q, %v; want %q, true", got, ok, leaf)
	}
}

func TestResolveWorkspaceParent_noBare(t *testing.T) {
	dir := t.TempDir()
	leaf := filepath.Join(dir, "main")
	if err := os.MkdirAll(leaf, 0755); err != nil {
		t.Fatal(err)
	}
	testutil.WriteCheaseeSettingsFile(t, leaf, `{}`)
	if _, ok := resolveWorkspaceParent(dir); ok {
		t.Error("parent without .bare sibling must not resolve")
	}
}

func TestResolveWorkspaceParent_ambiguousRefuse(t *testing.T) {
	parent := t.TempDir()
	if err := os.MkdirAll(filepath.Join(parent, ".bare"), 0755); err != nil {
		t.Fatal(err)
	}
	for _, branch := range []string{"main", "feature"} {
		leaf := filepath.Join(parent, branch)
		if err := os.MkdirAll(leaf, 0755); err != nil {
			t.Fatal(err)
		}
		testutil.WriteCheaseeSettingsFile(t, leaf, `{}`)
	}
	if _, ok := resolveWorkspaceParent(parent); ok {
		t.Error("two settings-bearing leaves must not resolve (ambiguous)")
	}
}

func TestResolveStartWorkspace_fromParent(t *testing.T) {
	parent, leaf := workspaceParentFixture(t)
	root, state, err := resolveStartWorkspace(parent)
	if err != nil {
		t.Fatalf("resolveStartWorkspace: %v", err)
	}
	if state != WorkspaceInitialized {
		t.Errorf("from parent → WorkspaceInitialized, got %v", state)
	}
	if root != leaf {
		t.Errorf("from parent → root %q, want %q", root, leaf)
	}
}
