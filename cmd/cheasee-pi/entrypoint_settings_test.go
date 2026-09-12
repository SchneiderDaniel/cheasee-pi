package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 3: committed dogfooding settings rework
// ──────────────────────────────────────────────

func TestCommittedSettings_NoParentPrivatePiRefs(t *testing.T) {
	content := readCommittedSettings(t)
	if strings.Contains(content, "../private-pi") {
		t.Error("committed settings must not reference ../private-pi (untracked — broken for fresh clones)")
	}
}

func TestCommittedSettings_PrivatePathsPointAtOpt(t *testing.T) {
	content := readCommittedSettings(t)
	for _, want := range []string{
		"/opt/cheasee-pi/private-pi/extensions/check-extensions",
		"/opt/cheasee-pi/private-pi/prompts",
		"/opt/cheasee-pi/private-pi/skills",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("committed settings must reference %q", want)
		}
	}
}

func TestCommittedSettings_TrackedPathsRepoLocal(t *testing.T) {
	content := readCommittedSettings(t)
	for _, want := range []string{
		"\"rtk\"",        // extensions: tracked local extension kept
		"\".pi/skills\"", // skills: tracked local dir kept
		"\"cheasee-pi\"", // theme unchanged
		"ponytail",       // packages unchanged
	} {
		if !strings.Contains(content, want) {
			t.Errorf("committed settings must keep %q", want)
		}
	}
}

func TestCommittedSettings_ValidJSON(t *testing.T) {
	content := readCommittedSettings(t)
	var doc map[string]any
	if err := json.Unmarshal([]byte(content), &doc); err != nil {
		t.Fatalf("committed .pi/settings.json must parse as valid JSON: %v", err)
	}
	for _, key := range []string{"extensions", "skills", "prompts", "theme", "packages", "defaultModel"} {
		if _, ok := doc[key]; !ok {
			t.Errorf("committed settings must keep top-level key %q", key)
		}
	}
}

func TestScaffoldSettings_Unchanged(t *testing.T) {
	content := readScaffoldSettings(t)
	// The scaffold governs consumer repos (points at the baked /opt tree) and
	// must not converge with the committed dogfooding settings. private-pi is
	// gitignored and never present in the image, so no private-pi paths.
	for _, want := range []string{
		"/opt/cheasee-pi/.pi/skills",
		"/opt/cheasee-pi/.pi/prompts",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("scaffold settings must still point at %q (consumer repos)", want)
		}
	}
	if strings.Contains(content, "private-pi") {
		t.Error("scaffold settings must not reference private-pi (gitignored, never in the image)")
	}
}
