package main

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestApplyComposeEnv_inheritedProjectNameReplaced(t *testing.T) {
	t.Setenv("COMPOSE_PROJECT_NAME", "user-project")
	workdir := t.TempDir()

	cmd := &mockCmd{}
	applyComposeEnv(cmd, workdir, containerName(workdir), t.TempDir())

	var count int
	for _, e := range cmd.env {
		if strings.HasPrefix(e, "COMPOSE_PROJECT_NAME=") {
			count++
		}
	}
	if count != 1 {
		t.Errorf("inherited COMPOSE_PROJECT_NAME must be replaced (exactly 1 entry), got %d", count)
	}
	if !slices.Contains(cmd.env, "COMPOSE_PROJECT_NAME="+composeProjectName(workdir)) {
		t.Errorf("derived project name must be injected, got %v", cmd.env)
	}
}

func TestApplyComposeEnv_nameOverrideKeepsDerivedProject(t *testing.T) {
	// --name replaces the container name verbatim, but the compose project
	// name stays repo-derived so compose labels stay workspace-scoped.
	workdir := t.TempDir()
	cmd := &mockCmd{}
	applyComposeEnv(cmd, workdir, "my-custom-name", t.TempDir())

	if !slices.Contains(cmd.env, "CHEASEEPI_CONTAINER=my-custom-name") {
		t.Errorf("--name override must replace the container name verbatim, got %v", cmd.env)
	}
	if !slices.Contains(cmd.env, "COMPOSE_PROJECT_NAME="+composeProjectName(workdir)) {
		t.Errorf("project name must stay repo-derived under --name override, got %v", cmd.env)
	}
}

// ──────────────────────────────────────────────
// UI env injection (PI_UI_PORT / PI_UI_CONTAINER)
// ──────────────────────────────────────────────

// assertOneUIEnv asserts exactly one PI_UI_PORT and one PI_UI_CONTAINER entry
// and returns the resolved port — duplicate entries resolve
// nondeterministically across libc/exec builds, so the count is the contract.

func assertOneUIEnv(t *testing.T, env []string) string {
	t.Helper()
	var port string
	for _, key := range []string{"PI_UI_PORT", "PI_UI_CONTAINER"} {
		var hits []string
		for _, e := range env {
			if k, v, ok := strings.Cut(e, "="); ok && k == key {
				hits = append(hits, v)
			}
		}
		if len(hits) != 1 {
			t.Fatalf("exactly one %s entry expected, got %v", key, hits)
		}
		if key == "PI_UI_PORT" {
			port = hits[0]
		}
	}
	return port
}

func TestApplyComposeEnv_UIPortOneEntry(t *testing.T) {
	t.Setenv("PI_UI_PORT", "")
	workdir := t.TempDir()
	cmd := &mockCmd{}
	applyComposeEnv(cmd, workdir, containerName(workdir), t.TempDir())

	port := assertOneUIEnv(t, cmd.env)
	n, err := strconv.Atoi(port)
	if err != nil || n < uiPortBase || n >= uiPortBase+uiPortRange {
		t.Errorf("PI_UI_PORT must be a port in [9500, 10523], got %q", port)
	}
	if !slices.Contains(cmd.env, "PI_UI_CONTAINER="+uiContainerName(workdir)) {
		t.Errorf("PI_UI_CONTAINER must carry the repo-slug UI name, got %v", cmd.env)
	}
	// The CodeFlow env is untouched by the UI addition.
	assertOneCodeflowPort(t, cmd.env)
}

func TestApplyComposeEnv_UIPassThroughAndInheritedReplaced(t *testing.T) {
	// A host PI_UI_PORT passes through verbatim; an inherited PI_UI_CONTAINER is
	// stripped and replaced by the derived name. Exactly-one each proves
	// stripEnvKeys gained both keys.
	t.Setenv("PI_UI_PORT", "9000")
	t.Setenv("PI_UI_CONTAINER", "stale")
	workdir := t.TempDir()
	cmd := &mockCmd{}
	applyComposeEnv(cmd, workdir, containerName(workdir), t.TempDir())

	if port := assertOneUIEnv(t, cmd.env); port != "9000" {
		t.Errorf("user-set PI_UI_PORT must pass through verbatim, got %q", port)
	}
	if !slices.Contains(cmd.env, "PI_UI_CONTAINER="+uiContainerName(workdir)) {
		t.Errorf("PI_UI_CONTAINER must be the derived name, got %v", cmd.env)
	}
}

func TestApplyComposeEnv_UISettingsWins(t *testing.T) {
	t.Setenv("PI_UI_PORT", "9000")
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"docker": {"uiPort": "9100"}}`)
	cmd := &mockCmd{}
	applyComposeEnv(cmd, workdir, containerName(workdir), t.TempDir())

	if !slices.Contains(cmd.env, "PI_UI_PORT=9100") {
		t.Errorf("settings docker.uiPort must win over env, got %v", cmd.env)
	}
}

// ──────────────────────────────────────────────
// pi build stamp (compose env seam)
// ──────────────────────────────────────────────

// assertOnePiBuildStamp asserts exactly one PI_BUILD_STAMP entry and returns
// its value — duplicate entries resolve nondeterministically, and an inherited
// value must never win over the CLI-owned one.

func assertOnePiBuildStamp(t *testing.T, env []string) string {
	t.Helper()
	var hits []string
	for _, e := range env {
		if k, v, ok := strings.Cut(e, "="); ok && k == "PI_BUILD_STAMP" {
			hits = append(hits, v)
		}
	}
	if len(hits) != 1 {
		t.Fatalf("exactly one PI_BUILD_STAMP entry expected, got %v", hits)
	}
	return hits[0]
}

func TestApplyComposeEnv_PiBuildStampOneEntry(t *testing.T) {
	t.Setenv("PI_BUILD_STAMP", "")
	workdir := t.TempDir()
	cmd := &mockCmd{}
	applyComposeEnv(cmd, workdir, containerName(workdir), t.TempDir())

	stamp := assertOnePiBuildStamp(t, cmd.env)
	if stamp == "" {
		t.Fatal("PI_BUILD_STAMP must be non-empty (cache-busting contract)")
	}
	if _, err := strconv.Atoi(stamp); err != nil {
		t.Errorf("PI_BUILD_STAMP must be unix seconds (all digits), got %q", stamp)
	}
}

func TestApplyComposeEnv_PiBuildStampReplacesInherited(t *testing.T) {
	// An inherited PI_BUILD_STAMP must be stripped and replaced by the
	// CLI-owned value (proves stripEnvKeys gained the key).
	t.Setenv("PI_BUILD_STAMP", "stale")
	workdir := t.TempDir()
	cmd := &mockCmd{}
	applyComposeEnv(cmd, workdir, containerName(workdir), t.TempDir())

	stamp := assertOnePiBuildStamp(t, cmd.env)
	if stamp == "stale" || stamp == "" {
		t.Errorf("CLI-owned PI_BUILD_STAMP must replace the inherited value, got %q", stamp)
	}
}

func TestApplyComposeEnv_UIPortExhaustionWarns(t *testing.T) {
	t.Setenv("PI_UI_PORT", "")
	saved := portProbe
	portProbe = func(p int) error { return fmt.Errorf("in use") }
	t.Cleanup(func() { portProbe = saved })

	workdir := t.TempDir()
	var cmd *mockCmd
	stderr := testutil.CaptureStderr(t, func() {
		cmd = &mockCmd{}
		applyComposeEnv(cmd, workdir, containerName(workdir), t.TempDir())
	})
	for _, e := range cmd.env {
		if strings.HasPrefix(e, "PI_UI_PORT=") {
			t.Errorf("exhaustion must leave no PI_UI_PORT entry, got %q", e)
		}
	}
	if !strings.Contains(stderr, "UI port") {
		t.Errorf("exhaustion must warn on stderr, got: %q", stderr)
	}
	// The container name is independent of port resolution: still injected.
	if !slices.Contains(cmd.env, "PI_UI_CONTAINER="+uiContainerName(workdir)) {
		t.Errorf("PI_UI_CONTAINER must still be injected on port exhaustion, got %v", cmd.env)
	}
}
