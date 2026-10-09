package main

import (
	"os/exec"
	"strings"
	"testing"
)

func TestEntrypoint_VenvCopyLoop(t *testing.T) {
	content := readEntrypoint(t)
	// The two identical venv copy blocks fold into one loop; the source/dest
	// guards, mkdir, and cp -a survive per iteration.
	for _, want := range []string{
		"for v in web-search-venv scrapling-venv",
		`src="/opt/venvs/$v"`,
		`dst="/workspaces/main/.pi/$v"`,
		`[ -d "$src" ]`,
		`[ -d "$dst" ]`,
		"mkdir -p /workspaces/main/.pi",
		`cp -a "$src" "$dst"`,
	} {
		if !strings.Contains(content, want) {
			t.Errorf("venv pre-install loop must contain %q", want)
		}
	}
}

func TestEntrypoint_VenvStampRefresh(t *testing.T) {
	content := readEntrypoint(t)
	// #1986: a stale or root-owned workspace venv shadowed the baked one and
	// could not self-heal (the runtime user cannot write it). The copy is now
	// refreshed when the baked venv's stamp drifts or the copy is not agent-owned.
	for _, want := range []string{
		`cat "$dst/.cheasee-venv-stamp"`,
		`cat "$src/.cheasee-venv-stamp"`,
		`stat -c '%U' "$dst"`,
		`[ "$(stat -c '%U' "$dst" 2>/dev/null)" = "agentuser" ]`,
		"&& [ \"$(stat -c '%U' \"$dst\" 2>/dev/null)\" = \"agentuser\" ]; then\n            continue",
		`echo "Refreshing $v (stamp/ownership drift)…"`,
		`rm -rf "$dst"`,
		`chown -R agentuser:agentuser "$dst"`,
	} {
		if !strings.Contains(content, want) {
			t.Errorf("venv pre-install loop must contain %q", want)
		}
	}
	// The stamp must be written by the image at bake time (Dockerfile layer 5e),
	// otherwise both sides read empty and the guard compares nothing.
	dockerfile := readDockerfile(t)
	if !strings.Contains(dockerfile, `"/opt/venvs/$v/bin/pip" freeze`) {
		t.Error("Dockerfile must write the venv stamp from pip freeze")
	}
	if !strings.Contains(dockerfile, `"/opt/venvs/$v/.cheasee-venv-stamp"`) {
		t.Error("Dockerfile must write /opt/venvs/$v/.cheasee-venv-stamp")
	}
}

func TestEntrypoint_ChromiumGuardRevisionSpecific(t *testing.T) {
	content := readEntrypoint(t)
	// The startup guard must resolve the revision patchright uses; the old
	// `ls chromium-*/chrome` glob passed for a build the crawler never looks for
	// — the exact mismatch of #1986.
	if !strings.Contains(content, "browsers.json") {
		t.Error("entrypoint chromium guard must read the expected revision from patchright's browsers.json")
	}
	if !strings.Contains(content, `[ ! -f "/opt/playwright-browsers/chromium-$CHROMIUM_REV/chrome-linux64/chrome" ]`) {
		t.Error("entrypoint chromium guard must assert the resolved revision directory")
	}
	if strings.Contains(content, `ls /opt/playwright-browsers/chromium-*/chrome-linux64/chrome`) {
		t.Error("the any-chromium glob guard must be gone (it passes on a mismatched revision)")
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
