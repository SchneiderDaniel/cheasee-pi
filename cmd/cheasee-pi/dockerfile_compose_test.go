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

func TestCompose_CodeflowLoopbackOnly(t *testing.T) {
	content := readCompose(t)
	// Rationale survives: the comment above the mapping names the bind IP var
	// and the loopback default (soft guard against silent revert).
	if !strings.Contains(content, "CODEFLOW_HOST_IP") {
		t.Error("compose port-mapping comment must document CODEFLOW_HOST_IP")
	}
	if !strings.Contains(content, "127.0.0.1") {
		t.Error("compose port-mapping comment must state the loopback default")
	}

	// codeflowPort returns the rendered services.codeflow.ports[0] entry and
	// asserts cheasee-pi keeps publishing no ports (codeflow stays the only
	// host ingress).
	codeflowPort := func(rendered string) string {
		t.Helper()
		var doc map[string]any
		if err := yaml.Unmarshal([]byte(rendered), &doc); err != nil {
			t.Fatalf("rendered docker-compose.yml must parse as valid YAML: %v", err)
		}
		services := doc["services"].(map[string]any)
		if _, ok := services["cheasee-pi"].(map[string]any)["ports"]; ok {
			t.Error("cheasee-pi service must declare no ports (codeflow is the only host ingress)")
		}
		ports, ok := services["codeflow"].(map[string]any)["ports"].([]any)
		if !ok || len(ports) != 1 {
			t.Fatalf("codeflow must declare exactly one port mapping, got %v", ports)
		}
		// 3-segment colon spec regression guard: the raw mapping stays inside
		// the quoted string, so yaml base-60 float parsing cannot bite.
		return ports[0].(string)
	}

	// All vars unset → host side pinned to IPv4 loopback, container side
	// stays 8470. This is the acceptance-criterion assertion.
	t.Setenv("CODEFLOW_HOST_IP", "")
	t.Setenv("CODEFLOW_PORT", "")
	if got := codeflowPort(renderComposeInterpolation(t, content)); got != "127.0.0.1:8470:8470" {
		t.Errorf("codeflow ports must pin the host side to 127.0.0.1 by default, got %q", got)
	}

	// Explicit CODEFLOW_PORT override survives the loopback pin.
	t.Setenv("CODEFLOW_PORT", "9000")
	if got := codeflowPort(renderComposeInterpolation(t, content)); got != "127.0.0.1:9000:8470" {
		t.Errorf("CODEFLOW_PORT override must survive the loopback pin, got %q", got)
	}

	// Documented opt-in: CODEFLOW_HOST_IP=0.0.0.0 restores all-interfaces.
	t.Setenv("CODEFLOW_HOST_IP", "0.0.0.0")
	if got := codeflowPort(renderComposeInterpolation(t, content)); got != "0.0.0.0:9000:8470" {
		t.Errorf("CODEFLOW_HOST_IP=0.0.0.0 must be the explicit opt-in, got %q", got)
	}

	// Boundary: empty-string CODEFLOW_HOST_IP → `:-` default applies
	// (compose `:-` semantics, not `-`).
	t.Setenv("CODEFLOW_HOST_IP", "")
	t.Setenv("CODEFLOW_PORT", "")
	if got := codeflowPort(renderComposeInterpolation(t, content)); got != "127.0.0.1:8470:8470" {
		t.Errorf("empty CODEFLOW_HOST_IP must fall back to the loopback default, got %q", got)
	}
}

// ──────────────────────────────────────────────
// ui service (web control center sidecar)
// ──────────────────────────────────────────────

// composeService parses compose content and returns the named service block.
func composeService(t *testing.T, content, name string) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(content), &doc); err != nil {
		t.Fatalf("docker-compose.yml must parse as valid YAML: %v", err)
	}
	services, ok := doc["services"].(map[string]any)
	if !ok {
		t.Fatalf("services section missing: %v", doc)
	}
	svc, ok := services[name].(map[string]any)
	if !ok {
		t.Fatalf("service %q missing", name)
	}
	return svc
}

func TestCompose_UILoopbackOnly(t *testing.T) {
	content := readCompose(t)

	// The ui block must not carry a host-IP env seam or any all-interfaces
	// literal — loopback is a hard invariant here, unlike codeflow's opt-in.
	idx := strings.Index(content, "\n  ui:")
	if idx < 0 {
		t.Fatal("ui service block not found in compose file")
	}
	uiBlock := content[idx:]
	for _, forbidden := range []string{"PI_UI_HOST_IP", "0.0.0.0"} {
		if strings.Contains(uiBlock, forbidden) {
			t.Errorf("ui block must not contain %q (loopback is a hard invariant)", forbidden)
		}
	}

	uiPort := func(rendered string) string {
		t.Helper()
		ports, ok := composeService(t, rendered, "ui")["ports"].([]any)
		if !ok || len(ports) != 1 {
			t.Fatalf("ui must declare exactly one port mapping, got %v", ports)
		}
		// 3-segment colon spec stays quoted (yaml base-60 float parse guard).
		return ports[0].(string)
	}

	// Defaults unset → host loopback, container side 3000 (acceptance criterion).
	t.Setenv("PI_UI_PORT", "")
	if got := uiPort(renderComposeInterpolation(t, content)); got != "127.0.0.1:9500:3000" {
		t.Errorf("ui ports must pin host side to 127.0.0.1 and container side to 3000 by default, got %q", got)
	}

	// Explicit PI_UI_PORT override survives the loopback pin.
	t.Setenv("PI_UI_PORT", "9000")
	if got := uiPort(renderComposeInterpolation(t, content)); got != "127.0.0.1:9000:3000" {
		t.Errorf("PI_UI_PORT override must survive the loopback pin, got %q", got)
	}

	// Boundary: empty string falls back to the `:-` default.
	t.Setenv("PI_UI_PORT", "")
	if got := uiPort(renderComposeInterpolation(t, content)); got != "127.0.0.1:9500:3000" {
		t.Errorf("empty PI_UI_PORT must fall back to the 9500 default, got %q", got)
	}
}

func TestCompose_UIManagedShape(t *testing.T) {
	svc := composeService(t, readCompose(t), "ui")
	if got := svc["container_name"]; got != "${PI_UI_CONTAINER:-ui}" {
		t.Errorf("ui container_name = %v, want ${PI_UI_CONTAINER:-ui}", got)
	}
	if got := svc["restart"]; got != "unless-stopped" {
		t.Errorf("ui restart = %v, want unless-stopped", got)
	}
	labels, ok := svc["labels"].([]any)
	if !ok || len(labels) != 1 || labels[0] != managedLabel {
		t.Errorf("ui labels must be exactly [%s] (no spec stamp), got %v", managedLabel, labels)
	}
}

func TestCompose_UIMounts(t *testing.T) {
	svc := composeService(t, readCompose(t), "ui")
	vols, ok := svc["volumes"].([]any)
	if !ok {
		t.Fatalf("ui volumes missing, got %v", svc["volumes"])
	}
	want := []string{
		"${WORKSPACE_HOST_PATH}:/workspaces/main${VOLUME_RELABEL:-}",
		"~/.config/gh:/home/agentuser/.config/gh:ro${VOLUME_RELABEL:-}",
		"~/.config/cheasee-pi:/home/agentuser/.config/cheasee-pi:ro${VOLUME_RELABEL:-}",
	}
	for _, w := range want {
		if !slices.Contains(vols, any(w)) {
			t.Errorf("ui volumes must contain %q, got %v", w, vols)
		}
	}
}

func TestCompose_UINoDockerSock(t *testing.T) {
	if strings.Contains(readCompose(t), "/var/run/docker.sock") {
		t.Error("compose must not mount the docker socket (epic hard constraint)")
	}
}

func TestCompose_UIBuildContext(t *testing.T) {
	build, ok := composeService(t, readCompose(t), "ui")["build"].(map[string]any)
	if !ok {
		t.Fatal("ui build section missing")
	}
	if got := build["context"]; got != "ui" {
		t.Errorf("ui build context = %v, want ui (the ui/ subtree, not the whole cache dir)", got)
	}
	if got := build["dockerfile"]; got != "Dockerfile" {
		t.Errorf("ui build dockerfile = %v, want Dockerfile", got)
	}
}
