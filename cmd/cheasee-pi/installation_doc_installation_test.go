package main

import (
	"os"
	"strings"
	"testing"
)

func TestInstallationDoc_GoCliPathVersion(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	// The VERSION assignment should not be the stale placeholder
	if strings.Contains(content, `VERSION="0.1.0"`) {
		t.Error("VERSION in docs/installation.md is still the stale placeholder 0.1.0; update to match rootCmd.Version")
	}
}

// TestInstallationDoc_TwoStepFirstRun verifies the empty-folder gate bullet
// describes the two-step flow: init runs and STOPS (init never launches pi),
// and the user re-runs start to launch.

func TestInstallationDoc_TwoStepFirstRun(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	if strings.Contains(content, "same invocation") {
		t.Error("installation.md must not describe a one-shot continuation (init + start fused)")
	}
	if !strings.Contains(content, "run `cheasee-pi start` again") {
		t.Error("installation.md should describe the two-step handoff (run start again after init)")
	}
}

// TestInstallationDoc_SkillRepoStep verifies the init step list documents the
// custom skill-repo phase and its non-interactive --skill-repo flag, with the
// one-consistent-term wording (skills defined once, skill repos as the git
// delivery source, no extension/package terms).

func TestInstallationDoc_SkillRepoStep(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "custom skill") && !strings.Contains(content, "skill repositor") {
		t.Error("installation.md should document the custom skill-repo init step")
	}
	if !strings.Contains(content, "--skill-repo") {
		t.Error("installation.md should document the --skill-repo flag")
	}
	if !strings.Contains(content, "pi update") {
		t.Error("installation.md should mention the pi update reconciliation benefit")
	}

	// Terminology contract: step 7 carries the definition, the note heading
	// and body use the canonical terms, and extension/package wording is gone.
	if !strings.Contains(content, "Asks for custom skills (reusable instruction sets for pi)") {
		t.Error("installation.md step 7 must define skills (reusable instruction sets for pi)")
	}
	if !strings.Contains(content, "> Custom skills?") {
		t.Error("installation.md note heading must read '> Custom skills?'")
	}
	// The note body wraps across blockquote lines — flatten whitespace so the
	// guard is wrap-tolerant (the doc↔CLI sync is manual, no parity harness).
	flat := strings.Join(strings.Fields(strings.ReplaceAll(content, "\n> ", " ")), " ")
	if !strings.Contains(flat, "records custom skills (git-hosted skill repository specs) without a prompt") {
		t.Error("installation.md note body must say 'records custom skills (git-hosted skill repository specs) without a prompt'")
	}
	for _, gone := range []string{"custom skill/extension", "Skill/extension"} {
		if strings.Contains(content, gone) {
			t.Errorf("installation.md must not contain %q (one consistent term)", gone)
		}
	}
}

// TestDailyUsageDoc_TwoStepFirstRun verifies daily-usage.md describes the
// two-step handoff: init auto-runs and stops, then the user re-runs start.
