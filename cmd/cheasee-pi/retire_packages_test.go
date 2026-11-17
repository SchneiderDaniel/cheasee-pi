package main

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// The use case happy paths: the bug reproduction, surgical preservation, the
// idempotent rerun plus the dry-run contract.

// TestRetirePackages_RemovesAllThreeLocations is the bug's happy path: the
// package element, the skillRepos seed and the exact checkout all go, and the
// report names each of them once.
func TestRetirePackages_RemovesAllThreeLocations(t *testing.T) {
	root := staleWorkspace(t)

	rep, err := retirePackages(root, retireOptions{})
	if err != nil {
		t.Fatalf("retirePackages: %v", err)
	}

	assertAbsent(t, filepath.Join(root, ponytailClonePath))

	raw := string(readBytes(t, piSettingsFile(root)))
	if strings.Contains(raw, ponytailSource) {
		t.Errorf(".pi/settings.json still registers the retired package:\n%s", raw)
	}
	cheasee := string(readBytes(t, cheaseeSettingsFile(root)))
	if strings.Contains(cheasee, ponytailSource) {
		t.Errorf("cheasee-settings.json still seeds the retired skill repo:\n%s", cheasee)
	}

	if got := strings.Count(strings.Join(rep.Removed, " "), retiredPackageSource); got != 1 {
		t.Errorf("report must name the removed source once, got %v", rep.Removed)
	}
	if got := strings.Count(strings.Join(rep.CloneRemoved, " "), retiredCloneRel); got != 1 {
		t.Errorf("report must name the removed clone once, got %v", rep.CloneRemoved)
	}
}

// TestRetirePackages_PreservesUnrelatedBytes proves the edit is surgical: the
// unrelated package entry's bytes, the unrelated skill repo, and an unknown
// top-level key survive verbatim.
func TestRetirePackages_PreservesUnrelatedBytes(t *testing.T) {
	root := staleWorkspace(t)
	// The fixture is written in the encoding the settings engine emits, so a
	// surviving entry's raw bytes can be compared before and after.
	keptEntry := `"source": "` + keptPackageSource + `"`
	before := string(readBytes(t, piSettingsFile(root)))
	if !strings.Contains(before, keptEntry) {
		t.Fatalf("fixture must carry the unrelated entry, got:\n%s", before)
	}

	if _, err := retirePackages(root, retireOptions{}); err != nil {
		t.Fatalf("retirePackages: %v", err)
	}

	after := string(readBytes(t, piSettingsFile(root)))
	if !strings.Contains(after, keptEntry) {
		t.Errorf("unrelated package entry must survive byte-identically, got:\n%s", after)
	}
	if !strings.Contains(after, `"defaultModel": "kept-model"`) {
		t.Errorf("unrelated top-level key must survive, got:\n%s", after)
	}

	cheasee := testutil.ReadCheaseeSettingsRaw(t, root)
	repos, _ := cheasee["skillRepos"].([]any)
	if len(repos) != 1 || repos[0] != keptSkillRepo {
		t.Errorf("skillRepos = %v, want only %q", cheasee["skillRepos"], keptSkillRepo)
	}
	custom, _ := cheasee["customKey"].(map[string]any)
	if got := custom["a"]; got != float64(1) {
		t.Errorf("unknown top-level key customKey must survive, got %v", cheasee["customKey"])
	}
}

// TestRetirePackages_PreservesSiblingClones proves the deletion is scoped to
// the exact checkout: the sibling owner directory and the unrelated skill clone
// stay, so `.pi/git` is never removed wholesale.
func TestRetirePackages_PreservesSiblingClones(t *testing.T) {
	root := staleWorkspace(t)
	if _, err := retirePackages(root, retireOptions{}); err != nil {
		t.Fatalf("retirePackages: %v", err)
	}
	assertAbsent(t, filepath.Join(root, ponytailClonePath))
	assertPresent(t, filepath.Join(root, keptSiblingClone))
	assertPresent(t, filepath.Join(root, keptSkillClone))
	assertPresent(t, filepath.Join(root, ".pi", "git"))
}

// TestRetirePackages_Idempotent is the requirement the issue states outright:
// a second run reports nothing and rewrites nothing.
func TestRetirePackages_Idempotent(t *testing.T) {
	root := staleWorkspace(t)
	if _, err := retirePackages(root, retireOptions{}); err != nil {
		t.Fatalf("first run: %v", err)
	}
	piAfterFirst := readBytes(t, piSettingsFile(root))
	cheaseeAfterFirst := readBytes(t, cheaseeSettingsFile(root))

	rep, err := retirePackages(root, retireOptions{})
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if len(rep.Removed) != 0 || len(rep.CloneRemoved) != 0 || len(rep.NeedsConfirmation) != 0 {
		t.Errorf("converged run must report nothing, got %+v", rep)
	}
	assertBytesUnchanged(t, piSettingsFile(root), piAfterFirst)
	assertBytesUnchanged(t, cheaseeSettingsFile(root), cheaseeAfterFirst)
}

// TestRetirePackages_DryRunTouchesNothing pins the dry-run contract: the plan is
// reported, nothing is written, the checkout stays.
func TestRetirePackages_DryRunTouchesNothing(t *testing.T) {
	root := staleWorkspace(t)
	piBefore := readBytes(t, piSettingsFile(root))
	cheaseeBefore := readBytes(t, cheaseeSettingsFile(root))

	rep, err := retirePackages(root, retireOptions{DryRun: true})
	if err != nil {
		t.Fatalf("retirePackages: %v", err)
	}

	assertBytesUnchanged(t, piSettingsFile(root), piBefore)
	assertBytesUnchanged(t, cheaseeSettingsFile(root), cheaseeBefore)
	assertPresent(t, filepath.Join(root, ponytailClonePath))
	if !slices.Contains(rep.Removed, retiredPackageSource) {
		t.Errorf("dry run must report the would-be removal, got %+v", rep)
	}
	if !slices.Contains(rep.CloneRemoved, retiredCloneRel) {
		t.Errorf("dry run must report the would-be clone deletion, got %+v", rep)
	}
}
