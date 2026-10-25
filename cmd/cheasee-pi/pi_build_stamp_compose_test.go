package main

import (
	"fmt"
	"strings"
	"testing"
)

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
