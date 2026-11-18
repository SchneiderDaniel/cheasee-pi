package main

import (
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 8: documentation contract
//
// A credential change is only visible to FILE-backed consumers after the
// container is recreated (the bind mount is pinned to the inode resolved at
// creation), while exec-time delivery stays live. That asymmetry is the one
// operational fact a user cannot discover from behavior, so it is pinned here.
// ──────────────────────────────────────────────

func TestDocs_CredentialIsolation(t *testing.T) {
	content := readRepoFile(t, "docs/configuration.md")
	for _, want := range []string{
		authSecretMount,
		"read-only",
		"cheasee-pi start --build",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("docs/configuration.md must document the credential isolation contract (%q missing)", want)
		}
	}
	lower := strings.ToLower(content)
	if !strings.Contains(lower, "cheasee-pi auth") {
		t.Error("docs/configuration.md must name `cheasee-pi auth` as the credential writer")
	}
	if !strings.Contains(lower, "recreate") {
		t.Error("docs/configuration.md must state that a container recreate is required after a credential change")
	}
}

func TestDocs_CredentialIsolation_StaleWording(t *testing.T) {
	for _, rel := range []string{"docs/daily-usage.md", "docs/architecture.md"} {
		content := readRepoFile(t, rel)
		for _, stale := range []string{
			"mounts `~/.config/gh/` read-write",
			"mounts `~/.config/cheasee-pi` read-write",
		} {
			if strings.Contains(content, stale) {
				t.Errorf("%s still claims the agent mounts credentials read-write (%q) — the mount is one read-only file", rel, stale)
			}
		}
	}
}

func TestDocs_CredentialIsolation_RecreateNuance(t *testing.T) {
	content := readRepoFile(t, "docs/configuration.md")
	// File-backed consumers (the ui child env, the gh tmpfs seed, the
	// supervisor's file fallback) only see a change after recreate; exec-time
	// GH_TOKEN and provider keys stay live. Both halves must be stated, or the
	// note reads as "just restart".
	if !strings.Contains(content, "recreate") {
		t.Error("docs/configuration.md must state that file-backed consumers need a container recreate")
	}
	if !strings.Contains(content, "GH_TOKEN") {
		t.Error("docs/configuration.md must state that exec-time GH_TOKEN stays live across a credential change")
	}
	for _, want := range []string{"provider", "exec"} {
		if !strings.Contains(strings.ToLower(content), want) {
			t.Errorf("docs/configuration.md must explain the exec-time/provider half of the recreate nuance (%q missing)", want)
		}
	}
}
