package main

import (
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 1: structural repo detection — is_cheasee_pi_repo()
// ──────────────────────────────────────────────

func TestEntrypoint_DefinesIsCheaseePiRepo(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "is_cheasee_pi_repo() {") {
		t.Error("entrypoint must define is_cheasee_pi_repo()")
	}
	if !strings.Contains(content, "if is_cheasee_pi_repo; then") {
		t.Error("entrypoint must call is_cheasee_pi_repo in a conditional")
	}
}

func TestEntrypoint_DetectionMarkerDir(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "-d /workspaces/main/cmd/cheasee-pi/embedded/docker") {
		t.Error("detection must require -d /workspaces/main/cmd/cheasee-pi/embedded/docker")
	}
}

func TestEntrypoint_DetectionModuleMatch(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "grep -m1 '^module ' /workspaces/main/go.mod") {
		t.Error("detection must parse the module directive via grep -m1 '^module ' /workspaces/main/go.mod")
	}
	if !strings.Contains(content, "github.com/SchneiderDaniel/cheasee-pi") {
		t.Error("detection must match module github.com/SchneiderDaniel/cheasee-pi")
	}
}

func TestEntrypoint_DetectionNotContentBased(t *testing.T) {
	body := detectionBody(t, readEntrypoint(t))
	for _, resource := range []string{".pi/skills", ".pi/extensions", ".pi/prompts", ".pi/themes", "custom"} {
		if strings.Contains(body, resource) {
			t.Errorf("detection must be structural, not content-based — body must not reference %q", resource)
		}
	}
}

func TestEntrypoint_DetectionWorktreeSafe(t *testing.T) {
	body := detectionBody(t, readEntrypoint(t))
	if strings.Contains(body, ".git") {
		t.Error("detection must never inspect /workspaces/main/.git (worktrees use a .git file, not a dir)")
	}
}

func TestDockerfile_MarkerContractDocumented(t *testing.T) {
	content := readDockerfile(t)
	for _, want := range []string{
		"MARKER CONTRACT",
		"cmd/cheasee-pi/embedded/docker",
		"module github.com/SchneiderDaniel/cheasee-pi",
		"forks",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("Dockerfile Layer 6b comment must document the marker contract (%q)", want)
		}
	}
}
