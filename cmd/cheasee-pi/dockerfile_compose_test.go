package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// composePath is the embedded docker-compose.yml.
func composePath() string {
	return filepath.Join("embedded", "docker", "docker-compose.yml")
}

func readCompose(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(composePath())
	if err != nil {
		t.Fatalf("read embedded docker-compose.yml: %v", err)
	}
	return string(data)
}

func TestCompose_ValidYAMLAndProjectName(t *testing.T) {
	content := readCompose(t)
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(content), &doc); err != nil {
		t.Fatalf("docker-compose.yml must parse as valid YAML: %v", err)
	}
	// name: cheasee-pi is the fallback for direct compose usage (the CLI
	// always injects a per-repo COMPOSE_PROJECT_NAME; the cache-dir basename
	// — the version key, e.g. "0.50" — would fail compose ≥v2.17 charset
	// validation without it).
	if doc["name"] != "cheasee-pi" {
		t.Errorf("top-level name must be 'cheasee-pi' (fallback for direct usage), got %v", doc["name"])
	}
	// Both services carry the managed label — clean enumerates by it.
	services, ok := doc["services"].(map[string]any)
	if !ok {
		t.Fatalf("services section missing: %v", doc)
	}
	for _, svcName := range []string{"cheasee-pi", "codeflow"} {
		svc, ok := services[svcName].(map[string]any)
		if !ok {
			t.Fatalf("service %q missing", svcName)
		}
		labels, ok := svc["labels"].([]any)
		if !ok || !slices.Contains(labels, managedLabel) {
			t.Errorf("service %s must carry the managed label %q, got %v", svcName, managedLabel, labels)
		}
		if len(labels) != 1 {
			t.Errorf("service %s must carry no other labels, got %v", svcName, labels)
		}
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
		"${CHEASEEPI_MEMORY:-5G}",
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
