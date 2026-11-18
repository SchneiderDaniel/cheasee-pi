package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The no-follow contract: no component between the workspace and the checkout may
// be a symlink. Guarding only the leaf is not enough — a link one level up makes
// os.RemoveAll delete a directory outside the workspace just as well.

// cloneOwnerRel / cloneGitRel are the two parent prefixes a link can hide behind:
// the owner directory the retired checkout lives in, and the `.pi/git` tree above
// it. Both also hold sibling checkouts, so a symlink there is never the layout pi
// created.
const (
	cloneGitRel   = ".pi/git"
	cloneOwnerRel = ".pi/git/github.com/DietrichGebert"
)

// TestRetirePackages_SymlinkedCloneRefused never follows a link at the checkout
// itself: it is not the directory pi created, so the run refuses and leaves the
// target alone.
func TestRetirePackages_SymlinkedCloneRefused(t *testing.T) {
	root := staleWorkspace(t)
	clonePath := filepath.Join(root, ponytailClonePath)
	if err := os.RemoveAll(clonePath); err != nil {
		t.Fatalf("clear clone dir: %v", err)
	}
	target := seedExternalCheckout(t, "ponytail")
	if err := os.Symlink(target, clonePath); err != nil {
		t.Fatalf("symlink clone path: %v", err)
	}
	piBefore := readBytes(t, piSettingsFile(root))

	_, err := retirePackages(root, retireOptions{})
	if err == nil {
		t.Fatal("a symlinked checkout path must be refused")
	}
	if !strings.Contains(err.Error(), retiredCloneRel) {
		t.Errorf("error must name the refused path, got %v", err)
	}

	assertStillSymlink(t, clonePath)
	assertExternalCheckoutIntact(t, target, "ponytail")
	// Fail closed: the refusal is a precondition, so no settings were rewritten.
	assertBytesUnchanged(t, piSettingsFile(root), piBefore)
}

// TestRetirePackages_SymlinkedParentRefused is the audit regression: the owner
// directory above the checkout is a link to a directory outside the workspace. A
// leaf-only guard accepts this layout and a plain `start` deletes the external
// checkout, so every component has to be checked.
func TestRetirePackages_SymlinkedParentRefused(t *testing.T) {
	root := staleWorkspace(t)
	ownerDir := filepath.Join(root, cloneOwnerRel)
	if err := os.RemoveAll(ownerDir); err != nil {
		t.Fatalf("clear owner dir: %v", err)
	}
	target := seedExternalCheckout(t, "ponytail")
	if err := os.Symlink(target, ownerDir); err != nil {
		t.Fatalf("symlink owner dir: %v", err)
	}
	piBefore := readBytes(t, piSettingsFile(root))
	cheaseeBefore := readBytes(t, cheaseeSettingsFile(root))

	_, err := retirePackages(root, retireOptions{})
	if err == nil {
		t.Fatal("a symlinked owner directory must be refused")
	}
	if !strings.Contains(err.Error(), cloneOwnerRel) {
		t.Errorf("error must name the refused component, got %v", err)
	}

	assertStillSymlink(t, ownerDir)
	assertExternalCheckoutIntact(t, target, "ponytail")
	assertBytesUnchanged(t, piSettingsFile(root), piBefore)
	assertBytesUnchanged(t, cheaseeSettingsFile(root), cheaseeBefore)
}

// TestRetirePackages_SymlinkedGitTreeRefused is the same contract one level
// higher: `.pi/git` itself is a link, so nothing beneath it is the workspace's.
func TestRetirePackages_SymlinkedGitTreeRefused(t *testing.T) {
	root := staleWorkspace(t)
	gitDir := filepath.Join(root, cloneGitRel)
	if err := os.RemoveAll(gitDir); err != nil {
		t.Fatalf("clear .pi/git: %v", err)
	}
	target := seedExternalCheckout(t, "github.com", "DietrichGebert", "ponytail")
	if err := os.Symlink(target, gitDir); err != nil {
		t.Fatalf("symlink .pi/git: %v", err)
	}
	piBefore := readBytes(t, piSettingsFile(root))

	_, err := retirePackages(root, retireOptions{})
	if err == nil {
		t.Fatal("a symlinked .pi/git tree must be refused")
	}
	if !strings.Contains(err.Error(), cloneGitRel) {
		t.Errorf("error must name the refused component, got %v", err)
	}

	assertStillSymlink(t, gitDir)
	assertExternalCheckoutIntact(t, target, filepath.Join("github.com", "DietrichGebert", "ponytail"))
	assertBytesUnchanged(t, piSettingsFile(root), piBefore)
}

// TestRetirePackages_SymlinkedParentDryRunRefused pins the refusal to the
// precondition, not the write: a dry run must not claim it would delete a path it
// would in fact refuse.
func TestRetirePackages_SymlinkedParentDryRunRefused(t *testing.T) {
	root := staleWorkspace(t)
	ownerDir := filepath.Join(root, cloneOwnerRel)
	if err := os.RemoveAll(ownerDir); err != nil {
		t.Fatalf("clear owner dir: %v", err)
	}
	target := seedExternalCheckout(t, "ponytail")
	if err := os.Symlink(target, ownerDir); err != nil {
		t.Fatalf("symlink owner dir: %v", err)
	}

	rep, err := retirePackages(root, retireOptions{DryRun: true})
	if err == nil {
		t.Fatal("a dry run must refuse an unsafe path too")
	}
	if len(rep.CloneRemoved) != 0 {
		t.Errorf("a refused dry run must not report a clone removal, got %v", rep.CloneRemoved)
	}
	assertStillSymlink(t, ownerDir)
	assertExternalCheckoutIntact(t, target, "ponytail")
}

// seedExternalCheckout builds a checkout outside the workspace and returns its
// root, so an assertion can prove the migration never reached into it.
func seedExternalCheckout(t *testing.T, rel ...string) string {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(append([]string{root}, rel...)...)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir external checkout: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.js"), []byte("// external\n"), 0o644); err != nil {
		t.Fatalf("write external file: %v", err)
	}
	return root
}

// assertExternalCheckoutIntact fails while the external checkout lost its file —
// the damage a followed symlink would do.
func assertExternalCheckoutIntact(t *testing.T, root string, rel ...string) {
	t.Helper()
	path := filepath.Join(append([]string{root}, append(rel, "index.js")...)...)
	if _, err := os.Lstat(path); err != nil {
		t.Errorf("the symlink target must be intact, %s: %v", path, err)
	}
}

// assertStillSymlink fails while path stopped being a link — the refusal is
// supposed to leave the layout untouched.
func assertStillSymlink(t *testing.T, path string) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("lstat %s: %v", path, err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Errorf("%s must still be a symlink", path)
	}
}
