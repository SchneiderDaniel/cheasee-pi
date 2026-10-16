package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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

// composeBuildArgs returns a service's build.args map (nil when the service
// declares no args).

func composeBuildArgs(t *testing.T, content, service string) map[string]any {
	t.Helper()
	build, ok := composeService(t, content, service)["build"].(map[string]any)
	if !ok {
		t.Fatalf("%s build section missing", service)
	}
	args, _ := build["args"].(map[string]any)
	return args
}

// TestCompose_UIBuildPassesPiVersion pins the ui image's pi build arg, so the
// UI-spawned RPC child is the same pi build the terminal client uses (AC5).

func TestCompose_UIBuildPassesPiVersion(t *testing.T) {
	args := composeBuildArgs(t, readCompose(t), "ui")
	if args == nil {
		t.Fatal("ui build args missing")
	}
	if got := args["PI_VERSION"]; got != "${PI_VERSION:-1.0.2}" {
		t.Errorf("ui build arg PI_VERSION = %v, want ${PI_VERSION:-1.0.2}", got)
	}
}

// TestCompose_PiBuildStampScopedToPiService pins the cache-bust scope to the
// agent service only. A global CLI `--build-arg` used to reach the ui
// sidecar's pi layer (and silently did nothing for codeflow, which declares no
// such ARG); the scope now lives in compose args, so this test fixes it.

func TestCompose_PiBuildStampScopedToPiService(t *testing.T) {
	compose := readCompose(t)
	if got := composeBuildArgs(t, compose, "cheasee-pi")["PI_BUILD_STAMP"]; got != "${PI_BUILD_STAMP:-}" {
		t.Errorf("cheasee-pi build arg PI_BUILD_STAMP = %v, want ${PI_BUILD_STAMP:-}", got)
	}
	if _, present := composeBuildArgs(t, compose, "ui")["PI_BUILD_STAMP"]; present {
		t.Error("ui build args must not declare PI_BUILD_STAMP (stamp scope is the agent image)")
	}
	if _, present := composeBuildArgs(t, compose, "codeflow")["PI_BUILD_STAMP"]; present {
		t.Error("codeflow build args must not declare PI_BUILD_STAMP")
	}
}

// TestCompose_PiBuildStampRendered proves the stamp reaches only the agent
// service once interpolated, while ui keeps no stamp arg at all.

func TestCompose_PiBuildStampRendered(t *testing.T) {
	t.Setenv("PI_BUILD_STAMP", "12345")
	compose := renderComposeInterpolation(t, readCompose(t))
	// fmt.Sprint: the text substitution runs before YAML parsing, so an
	// all-digits stamp lands as a YAML int here (real compose interpolates
	// inside the already-parsed string node, keeping it a string).
	if got := fmt.Sprint(composeBuildArgs(t, compose, "cheasee-pi")["PI_BUILD_STAMP"]); got != "12345" {
		t.Errorf("rendered cheasee-pi PI_BUILD_STAMP = %v, want 12345", got)
	}
	if _, present := composeBuildArgs(t, compose, "ui")["PI_BUILD_STAMP"]; present {
		t.Error("ui must render no PI_BUILD_STAMP arg")
	}
}

// TestCompose_PiVersionDefaultsMatchDockerfiles bounds the pin drift: the
// compose defaults for both images, both Dockerfile ARG defaults and the ui
// test-fixture sidecar must all name the same concrete version.

func TestCompose_PiVersionDefaultsMatchDockerfiles(t *testing.T) {
	dockerDefault := dockerfilePiVersionDefault(t, readDockerfile(t), "docker/Dockerfile")
	uiDefault := dockerfilePiVersionDefault(t, uiAsset(t, "Dockerfile"), "ui/Dockerfile")
	if dockerDefault != uiDefault {
		t.Fatalf("Dockerfile pins diverge: docker=%q ui=%q", dockerDefault, uiDefault)
	}

	compose := readCompose(t)
	for _, svc := range []string{"cheasee-pi", "ui"} {
		if got := composeBuildArgs(t, compose, svc)["PI_VERSION"]; got != "${PI_VERSION:-"+dockerDefault+"}" {
			t.Errorf("compose %s PI_VERSION = %v, want a pinned default ${PI_VERSION:-%s}", svc, got, dockerDefault)
		}
	}

	// Rendered default: with PI_VERSION unset both services resolve the pin.
	t.Setenv("PI_VERSION", "")
	rendered := renderComposeInterpolation(t, compose)
	for _, svc := range []string{"cheasee-pi", "ui"} {
		if got := composeBuildArgs(t, rendered, svc)["PI_VERSION"]; got != dockerDefault {
			t.Errorf("rendered %s PI_VERSION = %v, want %s", svc, got, dockerDefault)
		}
	}

	sidecar := strings.TrimSpace(uiAsset(t, "tests", "fixtures", "PI_VERSION"))
	if at := strings.LastIndex(sidecar, "@"); at < 0 || sidecar[at+1:] != dockerDefault {
		t.Errorf("fixture sidecar %q must pin the same version %q", sidecar, dockerDefault)
	}
}

// TestCompose_PiVersionLatestOverride: `latest` survives only as an explicit
// host-env override for both images.

func TestCompose_PiVersionLatestOverride(t *testing.T) {
	t.Setenv("PI_VERSION", "latest")
	rendered := renderComposeInterpolation(t, readCompose(t))
	for _, svc := range []string{"cheasee-pi", "ui"} {
		if got := composeBuildArgs(t, rendered, svc)["PI_VERSION"]; got != "latest" {
			t.Errorf("explicit PI_VERSION=latest must survive for %s, got %v", svc, got)
		}
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
