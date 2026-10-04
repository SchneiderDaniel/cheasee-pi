package main

import (
	"fmt"
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

func TestCompose_UIHealthcheck(t *testing.T) {
	content := readCompose(t)
	svc := composeService(t, content, "ui")
	hc, ok := svc["healthcheck"].(map[string]any)
	if !ok {
		t.Fatalf("ui healthcheck block missing, got %v", svc["healthcheck"])
	}
	test, ok := hc["test"].([]any)
	if !ok || len(test) == 0 {
		t.Fatalf("ui healthcheck.test missing, got %v", hc["test"])
	}
	joined := fmt.Sprint(test...)
	if !strings.Contains(joined, "http://127.0.0.1:3000/health") {
		t.Errorf("ui healthcheck must probe http://127.0.0.1:3000/health, got %q", joined)
	}
	for _, key := range []string{"interval", "retries", "start_period"} {
		if _, ok := hc[key]; !ok {
			t.Errorf("ui healthcheck must set %q, got %v", key, hc)
		}
	}

	// The raw ui block must not carry the banned host-seam literals (the
	// string-scanning TestCompose_UILoopbackOnly depends on it).
	idx := strings.Index(content, "\n  ui:")
	if idx < 0 {
		t.Fatal("ui service block not found in compose file")
	}
	uiBlock := content[idx:]
	for _, forbidden := range []string{"PI_UI_HOST_IP", "0.0.0.0"} {
		if strings.Contains(uiBlock, forbidden) {
			t.Errorf("ui block must not contain %q even in the healthcheck", forbidden)
		}
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

// TestCompose_UIUserAlignsWithHost pins the uid alignment that lets the ui
// server (non-root sidecar) traverse the host-owned 0700 ~/.config/cheasee-pi
// bind mount and read auth.json (AC1). Without it the mount is unreadable and
// AC1 is unreachable regardless of the resolution code.
func TestCompose_UIUserAlignsWithHost(t *testing.T) {
	svc := composeService(t, readCompose(t), "ui")
	want := "${HOST_UID:-1000}:${HOST_GID:-1000}"
	if got := svc["user"]; got != want {
		t.Errorf("ui user = %v, want %q (host uid alignment for the 0700 config mount)", got, want)
	}

	// Empty host env must fall back to a numeric default, not an empty
	// (compose-invalid) user string.
	t.Setenv("HOST_UID", "")
	t.Setenv("HOST_GID", "")
	rendered := composeService(t, renderComposeInterpolation(t, readCompose(t)), "ui")
	if got := rendered["user"]; got != "1000:1000" {
		t.Errorf("ui user with HOST_UID/GID unset = %v, want 1000:1000", got)
	}
}

// TestCompose_UIBuildPassesPiVersion pins the ui image's pi build arg, so the
// UI-spawned RPC child is the same pi build the terminal client uses (AC5).
func TestCompose_UIBuildPassesPiVersion(t *testing.T) {
	build, ok := composeService(t, readCompose(t), "ui")["build"].(map[string]any)
	if !ok {
		t.Fatal("ui build section missing")
	}
	args, ok := build["args"].(map[string]any)
	if !ok {
		t.Fatalf("ui build args missing, got %v", build["args"])
	}
	if got := args["PI_VERSION"]; got != "${PI_VERSION:-latest}" {
		t.Errorf("ui build arg PI_VERSION = %v, want ${PI_VERSION:-latest}", got)
	}
}

// ──────────────────────────────────────────────
// AC1/AC2/AC3 — resolved compose contract (untagged, daemon-free)
// ──────────────────────────────────────────────

// renderedServicePort parses rendered compose and returns the single port
// mapping string of a service.
func renderedServicePort(t *testing.T, rendered, service string) string {
	t.Helper()
	ports, ok := composeService(t, rendered, service)["ports"].([]any)
	if !ok || len(ports) != 1 {
		t.Fatalf("service %s must declare exactly one port mapping, got %v", service, ports)
	}
	// The 3-segment colon spec stays inside the quoted string, so yaml
	// base-60 float parsing cannot bite.
	return ports[0].(string)
}

// loopbackHostViolation returns a non-empty reason when a rendered port
// spec's host side is not IPv4 loopback. Mirrors the #1695 criterion for
// both mechanisms: ui is a literal `127.0.0.1:` with no seam, codeflow is
// `${CODEFLOW_HOST_IP:-127.0.0.1}:` with an explicit opt-out — so the helper
// keys on the rendered host side, never on a variable name.
func loopbackHostViolation(spec string) string {
	host, _, _ := strings.Cut(spec, ":")
	if host != "127.0.0.1" {
		return fmt.Sprintf("host side %q is not 127.0.0.1", host)
	}
	if strings.Contains(spec, "0.0.0.0") {
		return fmt.Sprintf("spec %q contains the all-interfaces literal", spec)
	}
	return ""
}

// TestCompose_ResolvedServiceNames (AC1): the rendered compose resolves every
// container_name from the identity.go functions, so a naming change fails
// here instead of silently producing a container the CLI cannot find.
func TestCompose_ResolvedServiceNames(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "widget")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	bare := filepath.Join(parent, ".bare")
	runGit(t, "init", "--bare", "-q", bare)
	// A real remote makes repoSlug resolve owner/repo, exactly as start would.
	runGit(t, "--git-dir", bare, "config", "remote.origin.url", "https://github.com/acme/widget.git")

	composeEnvForTest(t, root)
	rendered := renderComposeInterpolation(t, readCompose(t))

	want := map[string]string{
		"cheasee-pi": containerName(root),
		"codeflow":   codeflowContainerName(root),
		"ui":         uiContainerName(root),
	}
	for svc, name := range want {
		if got := composeService(t, rendered, svc)["container_name"]; got != name {
			t.Errorf("service %s container_name = %v, want %s (identity.go)", svc, got, name)
		}
	}
	// Non-tautological: interpolation actually happened (not the bare default).
	if got := composeService(t, rendered, "ui")["container_name"]; got != "ui-acme-widget" {
		t.Errorf("ui container_name = %v, want ui-acme-widget (slug resolved from the remote)", got)
	}
}

// TestCompose_ContainerNameDefaults (AC1 boundary): with the CLI-injected env
// unset, container_name falls back to the compose defaults documented for
// direct usage.
func TestCompose_ContainerNameDefaults(t *testing.T) {
	for _, key := range []string{"CHEASEEPI_CONTAINER", "CODEFLOW_CONTAINER", "PI_UI_CONTAINER"} {
		t.Setenv(key, "")
	}
	rendered := renderComposeInterpolation(t, readCompose(t))
	for svc, want := range map[string]string{"cheasee-pi": "cheasee-pi", "codeflow": "codeflow", "ui": "ui"} {
		if got := composeService(t, rendered, svc)["container_name"]; got != want {
			t.Errorf("service %s default container_name = %v, want %v", svc, got, want)
		}
	}
}

// TestCompose_ResolvedProjectAndImageRefs (AC1): the compose project name is
// the isolation key and the built image refs derive from it. Compose
// normalizes project names by stripping `_`/`.`, so a slug carrying them must
// still yield a charset-legal project that maps to the same image ref
// identity.go predicts.
func TestCompose_ResolvedProjectAndImageRefs(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "my_repo.v2")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}

	composeEnvForTest(t, root)
	project := composeProjectName(root)
	if project != "cheasee-pi-my-repo-v2" {
		t.Errorf("composeProjectName = %q, want the sanitized cheasee-pi-my-repo-v2", project)
	}
	if !regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`).MatchString(project) {
		t.Errorf("project name %q violates the compose ≥v2.17 charset", project)
	}
	if strings.ContainsAny(project, "_.") {
		t.Errorf("project name %q must not carry _ or . (compose normalizes them away)", project)
	}
	if got := cheaseeImageRef(root); got != project+"-cheasee-pi" {
		t.Errorf("cheaseeImageRef = %q, want %q", got, project+"-cheasee-pi")
	}
	// The ui service has no image: key, so Compose auto-names it <project>-ui.
	if got := project + "-ui"; got != "cheasee-pi-my-repo-v2-ui" {
		t.Errorf("ui auto-image ref = %q, want cheasee-pi-my-repo-v2-ui", got)
	}
}

// TestCompose_LoopbackMatrix (AC2): each service pins its published host side
// to loopback via its own mechanism — ui a literal, codeflow a
// `${CODEFLOW_HOST_IP:-127.0.0.1}` seam. The mechanism travels per row so a
// shared helper can never assume one variable name.
func TestCompose_LoopbackMatrix(t *testing.T) {
	content := readCompose(t)
	rows := []struct {
		service       string
		hostVar       string // "" = literal, no host-IP seam (ui)
		portVar       string
		containerPort string
	}{
		{service: "ui", hostVar: "", portVar: "PI_UI_PORT", containerPort: "3000"},
		{service: "codeflow", hostVar: "CODEFLOW_HOST_IP", portVar: "CODEFLOW_PORT", containerPort: "8470"},
	}
	for _, tc := range rows {
		t.Run(tc.service, func(t *testing.T) {
			t.Setenv(tc.portVar, "")
			if tc.hostVar != "" {
				t.Setenv(tc.hostVar, "")
			}
			spec := renderedServicePort(t, renderComposeInterpolation(t, content), tc.service)
			if v := loopbackHostViolation(spec); v != "" {
				t.Errorf("%s default port %q violates loopback: %s", tc.service, spec, v)
			}
			if !strings.HasSuffix(spec, ":"+tc.containerPort) {
				t.Errorf("%s container side must stay %s, got %q", tc.service, tc.containerPort, spec)
			}

			// An explicit host port override survives the loopback pin.
			t.Setenv(tc.portVar, "9000")
			spec = renderedServicePort(t, renderComposeInterpolation(t, content), tc.service)
			if v := loopbackHostViolation(spec); v != "" {
				t.Errorf("%s override port %q violates loopback: %s", tc.service, spec, v)
			}
			want := "127.0.0.1:9000:" + tc.containerPort
			if spec != want {
				t.Errorf("%s override port = %q, want %q", tc.service, spec, want)
			}

			if tc.hostVar != "" {
				// Documented opt-in: 0.0.0.0 restores all-interfaces.
				t.Setenv(tc.hostVar, "0.0.0.0")
				if got := renderedServicePort(t, renderComposeInterpolation(t, content), tc.service); !strings.HasPrefix(got, "0.0.0.0:") {
					t.Errorf("%s must honor its explicit all-interfaces opt-in, got %q", tc.service, got)
				}
			} else {
				// ui has no opt-in seam: the raw block must never carry one.
				idx := strings.Index(content, "\n  ui:")
				if idx < 0 {
					t.Fatal("ui service block not found")
				}
				for _, forbidden := range []string{"PI_UI_HOST_IP", "0.0.0.0"} {
					if strings.Contains(content[idx:], forbidden) {
						t.Errorf("ui block must not contain %q (loopback is a hard invariant)", forbidden)
					}
				}
			}
		})
	}

	// cheasee-pi publishes nothing — the two sidecars are the only host ingress.
	if _, ok := composeService(t, renderComposeInterpolation(t, content), "cheasee-pi")["ports"]; ok {
		t.Error("cheasee-pi service must declare no ports")
	}
}

// TestCompose_LoopbackGuardRejectsAllInterfaces guards the guard: the helper
// must fail loudly on an all-interfaces bind (the "break the loopback pin"
// validation step) and accept a correct spec, so it is never a vacuous pass.
func TestCompose_LoopbackGuardRejectsAllInterfaces(t *testing.T) {
	if loopbackHostViolation("0.0.0.0:9000:3000") == "" {
		t.Error("loopbackHostViolation must reject 0.0.0.0")
	}
	if loopbackHostViolation("127.0.0.1:9000:3000") != "" {
		t.Error("loopbackHostViolation must accept 127.0.0.1")
	}
}

// TestCompose_ReadyMarkerHealthcheck (AC3): the cheasee-pi healthcheck still
// gates on the entrypoint's /tmp/.cheasee-pi-ready marker, and codeflow
// declares no healthcheck (so `up --wait` cannot sequence AC3 off codeflow).
func TestCompose_ReadyMarkerHealthcheck(t *testing.T) {
	svc := composeService(t, readCompose(t), "cheasee-pi")
	hc, ok := svc["healthcheck"].(map[string]any)
	if !ok {
		t.Fatalf("cheasee-pi healthcheck missing, got %v", svc["healthcheck"])
	}
	joined := fmt.Sprint(hc["test"].([]any)...)
	if !strings.Contains(joined, "test -f /tmp/.cheasee-pi-ready") {
		t.Errorf("cheasee-pi healthcheck must gate on the ready marker, got %q", joined)
	}
	if _, ok := composeService(t, readCompose(t), "codeflow")["healthcheck"]; ok {
		t.Error("codeflow must declare no healthcheck (its absence is what makes --wait unreliable)")
	}
}
