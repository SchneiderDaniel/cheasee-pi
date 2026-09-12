package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// dockerfilePath is the embedded Dockerfile (canonical source, go:embed-backed).
func dockerfilePath() string {
	return filepath.Join("embedded", "docker", "Dockerfile")
}

func readDockerfile(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(dockerfilePath())
	if err != nil {
		t.Fatalf("read embedded Dockerfile: %v", err)
	}
	return string(data)
}

// ──────────────────────────────────────────────
// Phase 7: Dockerfile resource invariants
// ──────────────────────────────────────────────

func TestDockerfile_ClonesCheaseePi(t *testing.T) {
	content := readDockerfile(t)
	if !strings.Contains(content, "git clone --depth 1 --branch ${CHEASEE_REF} https://github.com/SchneiderDaniel/cheasee-pi /opt/cheasee-pi") {
		t.Error("Dockerfile must clone the cheasee-pi repo to /opt/cheasee-pi (ARG CHEASEE_REF)")
	}
	if !strings.Contains(content, "ARG CHEASEE_REF=main") {
		t.Error("Dockerfile must default ARG CHEASEE_REF to main")
	}
	if strings.Contains(content, "COPY pi-resources/") {
		t.Error("Dockerfile must not COPY a staged pi-resources tree (repo is cloned instead)")
	}
	if !strings.Contains(content, "/opt/cheasee-pi/.pi/extensions/ponytail") {
		t.Error("Dockerfile must remove the ponytail extension (loads from gitignored .pi/git)")
	}
}

func TestDockerfile_SymlinkLayerUsesExplicitHome(t *testing.T) {
	content := readDockerfile(t)
	// The symlink layer must target /home/agentuser/.pi/agent/... explicitly —
	// `~` after a USER switch resolves to /root (Docker does not set $HOME).
	if !strings.Contains(content, "/home/agentuser/.pi/agent/") {
		t.Error("symlink layer must use explicit /home/agentuser/.pi/agent paths")
	}
	if strings.Contains(content, "ln -s ~") {
		t.Error("symlink layer must not use ~ (USER-switch HOME pitfall)")
	}
}

func TestDockerfile_SymlinkLayerCoversResources(t *testing.T) {
	content := readDockerfile(t)
	// The nested loop maps all four resource dirs from the baked copy into
	// agent's global resource dir in one pass (type list + shared loop body) —
	// every resource must survive the loop collapse. "custom" and
	// "check-extensions" stay as guarded single links under it.
	for _, want := range []string{
		"for t in skills prompts extensions themes",
		"/opt/cheasee-pi/.pi/$t/*",
		"/home/agentuser/.pi/agent/$t/",
		"custom", // custom/* (guarded — gitignored, absent on fresh clones)
		"check-extensions",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("symlink layer should reference %q", want)
		}
	}
}

func TestDockerfile_AppendSystemPromptSymlink(t *testing.T) {
	content := readDockerfile(t)
	// Layer 6b must create the global append symlink — explicit
	// /home/agentuser path (USER-switch HOME pitfall) and guarded by
	// [ -f ] so old CHEASEE_REF tags without the repo-root file leave no
	// dangling link.
	if !strings.Contains(content, "ln -sfn /opt/cheasee-pi/APPEND_SYSTEM.md /home/agentuser/.pi/agent/APPEND_SYSTEM.md") {
		t.Error("Layer 6b must symlink /opt/cheasee-pi/APPEND_SYSTEM.md into /home/agentuser/.pi/agent/APPEND_SYSTEM.md")
	}
	if !strings.Contains(content, "[ -f /opt/cheasee-pi/APPEND_SYSTEM.md ]") {
		t.Error("APPEND_SYSTEM.md symlink must be guarded by [ -f /opt/cheasee-pi/APPEND_SYSTEM.md ] (no dangling links on old CHEASEE_REF tags)")
	}
}

func TestDockerfile_PiLayerAfterCloneBeforeEntrypoint(t *testing.T) {
	content := readDockerfile(t)
	// Issue #1603: the pi-coding-agent install is the one layer busted on
	// every build (PI_BUILD_STAMP cache-busting contract), so it must sit
	// AFTER the expensive clone/npm-ci/symlink layers (6b) and BEFORE the
	// entrypoint COPY (7) — otherwise a pi bump re-runs the whole clone +
	// npm ci. The byte-offset chain pins the order: clone < npm ci < symlink
	// wiring < pi install < entrypoint COPY.
	markers := []struct {
		name string
		text string
	}{
		{"clone (6b)", "git clone --depth 1 --branch ${CHEASEE_REF} https://github.com/SchneiderDaniel/cheasee-pi /opt/cheasee-pi"},
		{"npm ci (6b)", "npm ci --no-audit --no-fund"},
		{"symlink wiring (6b)", "chown -R agentuser:agentuser /home/agentuser/.pi"},
		{"pi install (6c)", "npm install -g --force @earendil-works/pi-coding-agent"},
		{"entrypoint COPY (7)", "COPY entrypoint.sh /usr/local/bin/entrypoint.sh"},
	}
	idxs := make([]int, len(markers))
	for i, m := range markers {
		idx := strings.Index(content, m.text)
		if idx == -1 {
			t.Fatalf("Dockerfile must contain %s marker %q (missing anchor — a reorder could silently pass)", m.name, m.text)
		}
		idxs[i] = idx
	}
	for i := 1; i < len(idxs); i++ {
		if idxs[i-1] > idxs[i] {
			t.Errorf("layer order broken: %s (offset %d) must precede %s (offset %d); the pi layer must sit after the 6b clone/npm-ci/symlink layers and before Layer 7's COPY", markers[i-1].name, idxs[i-1], markers[i].name, idxs[i])
		}
	}
	// Renumered 5h -> 6c: the new header must be present and the old one gone
	// (grep confirms "5h" appears nowhere else in the repo — renumber is safe).
	if !strings.Contains(content, "Layer 6c: pi-coding-agent") {
		t.Error("moved pi layer must be renumbered 'Layer 6c: pi-coding-agent'")
	}
	if strings.Contains(content, "Layer 5h") {
		t.Error("old 'Layer 5h' header must be gone (pi layer renumbered to 6c)")
	}
	// Stamp contract stays inside the moved RUN (AC4): exactly one ARG and one
	// echo, with the echo strictly between the install line and the Layer 7
	// header — it cannot drift out of the RUN block.
	if got := strings.Count(content, "ARG PI_BUILD_STAMP"); got != 1 {
		t.Errorf("exactly one 'ARG PI_BUILD_STAMP' required (cache-busting contract), got %d", got)
	}
	echoLine := `echo "${PI_BUILD_STAMP}" >/var/lib/pi-build-stamp`
	if got := strings.Count(content, echoLine); got != 1 {
		t.Errorf("exactly one stamp echo (%q) required, got %d", echoLine, got)
	}
	installIdx := strings.Index(content, "npm install -g --force @earendil-works/pi-coding-agent")
	layer7Idx := strings.Index(content, "# Layer 7:")
	if installIdx == -1 || layer7Idx == -1 {
		t.Fatal("pi install line or Layer 7 header missing")
	}
	echoIdx := strings.Index(content, echoLine)
	if !(installIdx < echoIdx && echoIdx < layer7Idx) {
		t.Errorf("stamp echo (offset %d) must sit inside the pi RUN: after the install line (offset %d) and before the Layer 7 header (offset %d)", echoIdx, installIdx, layer7Idx)
	}
	// No duplicate install, and the npm cache clean stays within the moved block.
	if got := strings.Count(content, "npm install -g --force @earendil-works/pi-coding-agent"); got != 1 {
		t.Errorf("exactly one pi install line required, got %d", got)
	}
	if block := content[installIdx:layer7Idx]; !strings.Contains(block, "npm cache clean --force") {
		t.Error("moved pi RUN must retain 'npm cache clean --force'")
	}
}

func TestDockerfile_PrivatePiSymlinkGuarded(t *testing.T) {
	content := readDockerfile(t)
	if !strings.Contains(content, "if [ -d /opt/cheasee-pi/private-pi ]") {
		t.Error("private-pi symlink must be guarded by 'if [ -d /opt/cheasee-pi/private-pi ]'")
	}
}

func TestDockerfile_WorkspacePathsStillMain(t *testing.T) {
	content := readDockerfile(t)
	// venv pre-install and entrypoint still target /workspaces/main (the fixed
	// mount point) — the repo is mounted there, not /workspaces.
	for _, want := range []string{"/workspaces/main", "worktree-fix.sh", "entrypoint.sh"} {
		if !strings.Contains(content, want) {
			t.Errorf("Dockerfile should still reference %q", want)
		}
	}
}

func TestDockerfile_Layer6bDeviationDocumented(t *testing.T) {
	// The baked /opt/cheasee-pi copy is product data (CHEASEE_REF-pinned,
	// re_point marker contract) — deliberately NOT a pi package. The
	// deviation must be documented: no pi git-folder layout, no second npm
	// install at build.
	content := readDockerfile(t)
	for _, want := range []string{
		"INTENTIONAL DEVIATION",
		"CHEASEE_REF",
		"NOT a pi package",
		"npm install",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("Layer 6b comment must document the intentional deviation (%q)", want)
		}
	}
}
