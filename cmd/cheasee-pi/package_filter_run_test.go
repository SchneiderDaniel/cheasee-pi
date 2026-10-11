package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestRunUpE_DryRunDoesNotReconcile(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	writeRawSettings(t, root, `{"packages": ["https://github.com/DietrichGebert/ponytail"]}`)
	before := readSettingsBytes(t, root)
	setUpRun(t, root) // dry-run
	stubUpFlow(t, root, false)

	testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	if got := readSettingsBytes(t, root); !bytes.Equal(before, got) {
		t.Errorf("dry-run must touch nothing:\n before=%s\n after =%s", before, got)
	}
}

// ──────────────────────────────────────────────
// Phase 4: preserved invariants (regression)
// ──────────────────────────────────────────────

func TestCommittedSettings_PonytailPackageFiltered(t *testing.T) {
	var doc struct {
		Packages []json.RawMessage `json:"packages"`
	}
	if err := json.Unmarshal([]byte(readCommittedSettings(t)), &doc); err != nil {
		t.Fatalf("committed settings packages: %v", err)
	}
	entries := doc.Packages
	if len(entries) < 2 {
		t.Fatalf("committed packages must keep ponytail + private-pi, got %s", entries)
	}
	assertDefaultFilterObject(t, entries[0])
	for i, entry := range entries {
		if isBarePackageString(entry, defaultSkillRepos[0]) {
			t.Errorf("entry %d is still the bare ponytail string, filter never applied: %s", i, entry)
		}
	}
	last := entries[len(entries)-1]
	if !isBarePackageString(last, "https://github.com/SchneiderDaniel/private-pi") {
		t.Errorf("private-pi must stay a bare string, got %s", last)
	}

	// The committed entry must be exactly what the reconciler considers done,
	// so `cheasee-pi start` in this repo never rewrites the file.
	s, err := loadSettingsFile(committedSettingsPath())
	if err != nil {
		t.Fatalf("load committed settings: %v", err)
	}
	changed, err := applyDefaultPackageFilters(s)
	if err != nil {
		t.Fatalf("apply filter to committed settings: %v", err)
	}
	if changed {
		t.Error("committed .pi/settings.json already carries the filter — reconcile must be a no-op")
	}
}

// committedSkillsDir is the repo's committed dogfooding skill layout (repo
// root, sibling of cmd/).

func committedSkillsDir() string {
	return filepath.Join("..", "..", ".pi", "skills")
}

// TestCommittedSkills_PonytailAuxiliaryNotLinked is the repo-layout half of the
// filter. The .pi/settings.json package filter only narrows the package
// manifest; skills under the project's .pi/skills dir register unconditionally.
// A committed link for an auxiliary ponytail skill therefore re-adds exactly
// what the filter removes, in every cheasee-pi dev session (dogfooding). The
// five top-level links were deleted with issue #1936 — this test fails if one
// returns, so the two halves cannot drift apart silently.

func TestCommittedSkills_PonytailAuxiliaryNotLinked(t *testing.T) {
	root := committedSkillsDir()
	top, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read %s: %v", root, err)
	}
	for _, e := range top {
		if strings.HasPrefix(e.Name(), "ponytail-") {
			t.Errorf("committed skill link %q bypasses the .pi/settings.json package filter — remove it (or drop the filter) so the five auxiliary skills stay unregistered", filepath.Join(root, e.Name()))
		}
	}

	// Nested links under the core skill dir are never discovered (pi stops at
	// the first SKILL.md in a directory), but they are dead weight pointing into
	// the gitignored clone — the same rule keeps them from accumulating.
	core := filepath.Join(root, "ponytail")
	nested, err := os.ReadDir(core)
	if err != nil {
		t.Fatalf("read %s: %v", core, err)
	}
	for _, e := range nested {
		if strings.HasPrefix(e.Name(), "ponytail-") {
			t.Errorf("stale nested auxiliary link %q under the core skill dir", filepath.Join(core, e.Name()))
		}
	}

	// The core skill must stay discoverable: pi registers a skill from the
	// SKILL.md in a dir named after it. Lstat, not Stat — a fresh checkout has
	// no .pi/git clone and the link is legitimately dangling, but the entry
	// itself must exist so `ln -s` in a re-clone can target it.
	if fi, err := os.Lstat(filepath.Join(core, "SKILL.md")); err != nil {
		t.Errorf("core ponytail SKILL.md must stay linked for dogfooding: %v", err)
	} else if fi.Mode()&os.ModeSymlink == 0 {
		t.Errorf("core ponytail SKILL.md must be a symlink into the package clone, got mode %s", fi.Mode())
	}
}
