package main

import (
	"os/exec"
	"strings"
	"testing"
)

func TestEntrypoint_VenvCopyLoop(t *testing.T) {
	content := readEntrypoint(t)
	// The two identical venv copy blocks fold into one loop; both guards,
	// mkdir, and cp -a survive per iteration.
	for _, want := range []string{
		"for v in web-search-venv scrapling-venv",
		"[ -d \"/opt/venvs/$v\" ]",
		"[ ! -d \"/workspaces/main/.pi/$v\" ]",
		"mkdir -p /workspaces/main/.pi",
		"cp -a \"/opt/venvs/$v\" \"/workspaces/main/.pi/$v\"",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("venv pre-install loop must contain %q", want)
		}
	}
}

// ──────────────────────────────────────────────
// Phase 4: bare-repo container plumbing (empty-folder init support)
// ──────────────────────────────────────────────

func TestEntrypoint_SafeDirectoryBare(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "safe.directory /workspaces/.bare") {
		t.Error("entrypoint must mark /workspaces/.bare as safe.directory (CVE-2022-24765 dubious-ownership mitigation)")
	}
}

func TestEntrypoint_BareChownParity(t *testing.T) {
	content := readEntrypoint(t)
	for _, want := range []string{
		"stat -c '%u:%g' /workspaces/.bare",
		"chown -R agentuser:agentuser /workspaces/.bare",
		"Fixing /workspaces/.bare ownership",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("entrypoint must chown /workspaces/.bare on ownership mismatch (%q)", want)
		}
	}
	// Existing main-worktree chown retained.
	if !strings.Contains(content, "chown -R agentuser:agentuser /workspaces/main") {
		t.Error("entrypoint must keep the /workspaces/main ownership fix")
	}
}

func TestEntrypoint_SyntaxValidBash(t *testing.T) {
	if err := exec.Command("bash", "-n", entrypointPath()).Run(); err != nil {
		t.Errorf("entrypoint.sh must pass bash -n: %v", err)
	}
}
