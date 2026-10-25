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

func TestDockerfile_FetchesCheaseePi(t *testing.T) {
	content := readDockerfile(t)
	if !strings.Contains(content, `git -C /opt/cheasee-pi fetch --depth 1 origin "${CHEASEE_COMMIT}"`) {
		t.Error("Dockerfile must fetch the resolved cheasee-pi commit into /opt/cheasee-pi")
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
