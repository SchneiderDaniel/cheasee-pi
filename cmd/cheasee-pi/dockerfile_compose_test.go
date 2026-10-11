package main

import (
	"os"
	"path/filepath"
	"regexp"
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

// renderComposeInterpolation substitutes every ${VAR:-default} in the compose
// content with the process env value (or the default when unset/empty),
// mirroring docker compose's `:-` semantics. Behavior asserted in the tests,
// not the substitution implementation.

func renderComposeInterpolation(t *testing.T, content string) string {
	t.Helper()
	re := regexp.MustCompile(`\$\{([A-Z0-9_]+):-([^}]*)\}`)
	return re.ReplaceAllStringFunc(content, func(m string) string {
		parts := re.FindStringSubmatch(m)
		if v := os.Getenv(parts[1]); v != "" {
			return v
		}
		return parts[2]
	})
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
	// Both services carry the managed label — clean enumerates by it. The
	// codeflow service additionally carries the CLI-owned spec stamp label
	// (warnIfCodeflowDrift compares it on the running&&!build path); the
	// main service must carry no other labels.
	services, ok := doc["services"].(map[string]any)
	if !ok {
		t.Fatalf("services section missing: %v", doc)
	}
	wantLabels := map[string][]any{
		"cheasee-pi": {managedLabel},
		"codeflow":   {managedLabel, "com.cheaseepi.codeflow-spec=${CHEASEEPI_CODEFLOW_SPEC:-}"},
		"ui":         {managedLabel},
	}
	for _, svcName := range []string{"cheasee-pi", "codeflow", "ui"} {
		svc, ok := services[svcName].(map[string]any)
		if !ok {
			t.Fatalf("service %q missing", svcName)
		}
		labels, ok := svc["labels"].([]any)
		if !ok || !slices.Contains(labels, managedLabel) {
			t.Errorf("service %s must carry the managed label %q, got %v", svcName, managedLabel, labels)
		}
		for _, want := range wantLabels[svcName] {
			if !slices.Contains(labels, want) {
				t.Errorf("service %s must carry label %q, got %v", svcName, want, labels)
			}
		}
		if len(labels) != len(wantLabels[svcName]) {
			t.Errorf("service %s must carry exactly %d labels, got %v", svcName, len(wantLabels[svcName]), labels)
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

// TestCompose_CodeflowMountsBareRepo pins the fix for #1934: the workspace is
// a linked worktree whose .git pointer (`../.bare/worktrees/main`) only
// resolves when the sibling bare repo is mounted. Without it the shim's
// `git check-ignore` filter fails open and CodeFlow analyzes gitignored
// installs (virtualenvs, .pi/git).

func TestCompose_CodeflowMountsBareRepo(t *testing.T) {
	svc := composeService(t, readCompose(t), "codeflow")
	vols, ok := svc["volumes"].([]any)
	if !ok {
		t.Fatalf("codeflow volumes missing, got %v", svc["volumes"])
	}
	want := "${WORKSPACE_BARE_PATH}:/workspaces/.bare:ro${VOLUME_RELABEL:-}"
	if !slices.Contains(vols, any(want)) {
		t.Errorf("codeflow volumes must mount the sibling bare repo %q, got %v", want, vols)
	}
}
