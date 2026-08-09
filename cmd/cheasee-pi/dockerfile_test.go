package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// dockerfilePath is the embedded Dockerfile (canonical source, go:embed-backed).
func dockerfilePath() string {
	return filepath.Join("embedded", "docker", "Dockerfile")
}

// composePath is the embedded docker-compose.yml.
func composePath() string {
	return filepath.Join("embedded", "docker", "docker-compose.yml")
}

func readDockerfile(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(dockerfilePath())
	if err != nil {
		t.Fatalf("read embedded Dockerfile: %v", err)
	}
	return string(data)
}

func readCompose(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(composePath())
	if err != nil {
		t.Fatalf("read embedded docker-compose.yml: %v", err)
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
	for _, want := range []string{
		".pi/skills",     // skills + .pi/skills resource dir
		".pi/prompts",    // prompts
		".pi/extensions", // extensions (caveman/supervisor/…) load globally
		"themes",         // themes
		"custom",         // custom/* (guarded — gitignored, absent on fresh clones)
		"check-extensions",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("symlink layer should reference %q", want)
		}
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

// ──────────────────────────────────────────────
// Phase 8: compose invariants + YAML validity
// ──────────────────────────────────────────────

func TestCompose_ValidYAMLAndProjectName(t *testing.T) {
	content := readCompose(t)
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(content), &doc); err != nil {
		t.Fatalf("docker-compose.yml must parse as valid YAML: %v", err)
	}
	if doc["name"] != "cheasee-pi" {
		t.Errorf("top-level name must be 'cheasee-pi' (up/down resolve the same project from any cache dir), got %v", doc["name"])
	}
}

func TestCompose_WorkspaceVolumeAbsolute(t *testing.T) {
	content := readCompose(t)
	if !strings.Contains(content, "${WORKSPACE_HOST_PATH}:/workspaces/main") {
		t.Error("cheasee-pi volume must bind ${WORKSPACE_HOST_PATH} at /workspaces/main")
	}
	if strings.Contains(content, "../../:/workspaces") {
		t.Error("relative repo-root volume must be gone (compose lives in the cache dir)")
	}
}

func TestCompose_ConfigMountsRetained(t *testing.T) {
	content := readCompose(t)
	for _, want := range []string{
		"~/.config/gh:/home/agentuser/.config/gh",
		"~/.config/cheasee-pi:/home/agentuser/.config/cheasee-pi",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("compose should retain bind-mount %q", want)
		}
	}
}

func TestCompose_BuildContextIsCacheDir(t *testing.T) {
	content := readCompose(t)
	if !strings.Contains(content, "context: .") {
		t.Error("build context must be . (the cache dir)")
	}
	if !strings.Contains(content, "dockerfile: Dockerfile") {
		t.Error("compose must reference the Dockerfile at the context root")
	}
}

func TestCompose_CodeflowPointsAtWorkspace(t *testing.T) {
	content := readCompose(t)
	for _, want := range []string{
		"REPO_ROOT=/workspaces/main",
		"${WORKSPACE_HOST_PATH}:/workspaces/main:ro",
		"./codeflow/config.json:/opt/codeflow/config.json:ro",
		"context: codeflow",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("codeflow service should contain %q", want)
		}
	}
}

func TestCompose_DefaultsPresent(t *testing.T) {
	content := readCompose(t)
	for _, want := range []string{
		"${CHEASEEPI_MEMORY:-2G}",
		"${CHEASEEPI_CPUS:-4.0}",
		"${CODEFLOW_PORT:-8470}",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("compose should keep default %q", want)
		}
	}
}

func TestCompose_BareSiblingMount(t *testing.T) {
	content := readCompose(t)
	// The sibling bare repo is bind-mounted at /workspaces/.bare so
	// worktree-fix.sh sees its expected layout; the workspace folder mount is
	// retained. :Z relabel (VOLUME_RELABEL) applies to both.
	if !strings.Contains(content, "${WORKSPACE_BARE_PATH}:/workspaces/.bare${VOLUME_RELABEL:-}") {
		t.Error("compose must bind ${WORKSPACE_BARE_PATH} at /workspaces/.bare with the relabel suffix")
	}
	if !strings.Contains(content, "${WORKSPACE_HOST_PATH}:/workspaces/main${VOLUME_RELABEL:-}") {
		t.Error("compose must keep the ${WORKSPACE_HOST_PATH}:/workspaces/main mount with the relabel suffix")
	}
	// The mount must be a sibling, never a parent-of-folder single mount.
	if strings.Contains(content, "${WORKSPACE_HOST_PATH}/../:/workspaces") {
		t.Error("compose must not mount the whole parent at /workspaces")
	}
}
