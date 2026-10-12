package main

import (
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

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
