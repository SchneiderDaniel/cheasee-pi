package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// Fail-closed plus convergence edges: missing, malformed, leftover, emptied.

// TestRetirePackages_MissingPISettings keeps the skillRepos cleanup working on
// a workspace whose `.pi/settings.json` pi has not created yet, and — crucially
// — never creates that file.
func TestRetirePackages_MissingPISettings(t *testing.T) {
	root := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, root, `{"skillRepos": ["`+retiredPackageSource+`", "`+keptSkillRepo+`"]}`)
	canonicalizeSettings(t, root)
	writeCloneFile(t, root, ponytailClonePath)

	if _, err := retirePackages(root, retireOptions{}); err != nil {
		t.Fatalf("retirePackages: %v", err)
	}

	assertAbsent(t, piSettingsFile(root))
	if strings.Contains(string(readBytes(t, cheaseeSettingsFile(root))), ponytailSource) {
		t.Error("skillRepos seed must still be cleaned without .pi/settings.json")
	}
}

// TestRetirePackages_MalformedPISettings fails closed: a broken settings file is
// an error and nothing is written anywhere.
func TestRetirePackages_MalformedPISettings(t *testing.T) {
	root := staleWorkspace(t)
	testutil.WriteSettingsFile(t, root, `{"packages": [`)
	cheaseeBefore := readBytes(t, cheaseeSettingsFile(root))

	if _, err := retirePackages(root, retireOptions{}); err == nil {
		t.Fatal("malformed .pi/settings.json must be an error")
	}

	assertBytesUnchanged(t, cheaseeSettingsFile(root), cheaseeBefore)
	assertPresent(t, filepath.Join(root, ponytailClonePath))
}

// TestRetirePackages_MalformedCheaseeSettings is the same fail-closed contract
// on the other file.
func TestRetirePackages_MalformedCheaseeSettings(t *testing.T) {
	root := staleWorkspace(t)
	testutil.WriteCheaseeSettingsFile(t, root, `{"skillRepos": `)
	piBefore := readBytes(t, piSettingsFile(root))

	if _, err := retirePackages(root, retireOptions{}); err == nil {
		t.Fatal("malformed cheasee-settings.json must be an error")
	}

	assertBytesUnchanged(t, piSettingsFile(root), piBefore)
	assertPresent(t, filepath.Join(root, ponytailClonePath))
}

// TestRetirePackages_RerunCleansCloneLeftByFailedRun is the converge case: a run
// that wrote the settings but died before the delete is finished by the next
// run, which writes nothing.
func TestRetirePackages_RerunCleansCloneLeftByFailedRun(t *testing.T) {
	root := staleWorkspace(t)
	if _, err := retirePackages(root, retireOptions{}); err != nil {
		t.Fatalf("first run: %v", err)
	}
	piAfterFirst := readBytes(t, piSettingsFile(root))
	cheaseeAfterFirst := readBytes(t, cheaseeSettingsFile(root))
	// Simulate the interrupted run: the checkout comes back, the settings stay
	// clean.
	writeCloneFile(t, root, ponytailClonePath)

	rep, err := retirePackages(root, retireOptions{})
	if err != nil {
		t.Fatalf("converging run: %v", err)
	}
	assertAbsent(t, filepath.Join(root, ponytailClonePath))
	if len(rep.Removed) != 0 {
		t.Errorf("converging run removes no registration, got %v", rep.Removed)
	}
	if !slices.Contains(rep.CloneRemoved, retiredCloneRel) {
		t.Errorf("converging run must report the leftover clone, got %+v", rep)
	}
	assertBytesUnchanged(t, piSettingsFile(root), piAfterFirst)
	assertBytesUnchanged(t, cheaseeSettingsFile(root), cheaseeAfterFirst)
}

// TestRetirePackages_PackagesKeyNotNulled guards the shape pi reads back: an
// emptied array stays `[]`, the file keeps its mode, and no temp file is left.
func TestRetirePackages_PackagesKeyNotNulled(t *testing.T) {
	root := staleWorkspaceWith(t, stalePackageObject, `"`+keptSkillRepo+`"`)
	if _, err := retirePackages(root, retireOptions{}); err != nil {
		t.Fatalf("retirePackages: %v", err)
	}

	raw := testutil.ReadSettingsRaw(t, root)
	packages, ok := raw["packages"]
	if !ok {
		t.Fatalf("`packages` must stay present (empty array), got: %v", raw)
	}
	if packages == nil {
		t.Fatal("`packages` must never become null")
	}
	if list, isList := packages.([]any); !isList || len(list) != 0 {
		t.Errorf("`packages` = %v, want an empty array", packages)
	}

	info, err := os.Stat(piSettingsFile(root))
	if err != nil {
		t.Fatalf("stat .pi/settings.json: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o644 {
		t.Errorf(".pi/settings.json mode = %o, want 644", perm)
	}
	leftovers, err := filepath.Glob(piSettingsFile(root) + "*")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(leftovers) != 1 || leftovers[0] != piSettingsFile(root) {
		t.Errorf("no temp file may be left behind, got %v", leftovers)
	}
}

// TestRetirePackages_EmptyWorkspaceNoop is the converged start: no deprecated
// registration anywhere means no write and an empty report.
func TestRetirePackages_EmptyWorkspaceNoop(t *testing.T) {
	root := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, root, `{"skillRepos": ["`+keptSkillRepo+`"]}`)
	testutil.WriteSettingsFile(t, root, `{"packages": ["`+keptPackageSource+`"]}`)
	canonicalizeSettings(t, root)
	piBefore := readBytes(t, piSettingsFile(root))
	cheaseeBefore := readBytes(t, cheaseeSettingsFile(root))

	rep, err := retirePackages(root, retireOptions{})
	if err != nil {
		t.Fatalf("retirePackages: %v", err)
	}
	if len(rep.Removed) != 0 || len(rep.CloneRemoved) != 0 || len(rep.NeedsConfirmation) != 0 {
		t.Errorf("clean workspace must report nothing, got %+v", rep)
	}
	assertBytesUnchanged(t, piSettingsFile(root), piBefore)
	assertBytesUnchanged(t, cheaseeSettingsFile(root), cheaseeBefore)
}
