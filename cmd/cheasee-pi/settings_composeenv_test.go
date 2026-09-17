package main

import (
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// applyComposeEnv reads ONLY cheasee-settings.json — .pi/settings.json is
// ignored entirely (pi's own file, single-source independence).

func TestApplyComposeEnv_ignoresPISettings(t *testing.T) {
	workdir := t.TempDir()
	// Only .pi/settings.json exists — its docker/gitIdentity sections must NOT
	// flow into the compose env (single source = cheasee-settings.json).
	testutil.WriteSettingsFile(t, workdir, `{"docker": {"memory": "4G", "cpus": "2.0"}, "gitIdentity": {"name": "Pi Name", "email": "pi@example.com"}}`)

	cmd := &mockCmd{}
	applyComposeEnv(cmd, workdir, containerName(workdir))

	for _, e := range cmd.env {
		if strings.HasPrefix(e, "CHEASEEPI_MEMORY=") || strings.HasPrefix(e, "CHEASEEPI_CPUS=") {
			t.Errorf(".pi/settings.json docker section must not feed compose env, got %q", e)
		}
		if e == "HOST_GIT_NAME=Pi Name" || e == "HOST_GIT_EMAIL=pi@example.com" {
			t.Errorf(".pi/settings.json gitIdentity must not feed compose env, got %q", e)
		}
	}
	if !slices.Contains(cmd.env, "WORKSPACE_BARE_PATH="+filepath.Join(filepath.Dir(workdir), ".bare")) {
		t.Errorf("WORKSPACE_BARE_PATH must resolve the sibling .bare, got %v", cmd.env)
	}
	if !slices.Contains(cmd.env, "CHEASEEPI_CONTAINER="+containerName(workdir)) {
		t.Errorf("CHEASEEPI_CONTAINER must carry the repo-slug container name, got %v", cmd.env)
	}
	if !slices.Contains(cmd.env, "CODEFLOW_CONTAINER="+codeflowContainerName(workdir)) {
		t.Errorf("CODEFLOW_CONTAINER must carry the repo-slug codeflow name, got %v", cmd.env)
	}
	if !slices.Contains(cmd.env, "COMPOSE_PROJECT_NAME="+composeProjectName(workdir)) {
		t.Errorf("compose env must carry the per-repo COMPOSE_PROJECT_NAME, got %v", cmd.env)
	}
	assertOneCodeflowPort(t, cmd.env)
}

// assertOneCodeflowPort asserts cmd.env carries exactly one CODEFLOW_PORT
// entry with a numeric value in the derived range.
func assertOneCodeflowPort(t *testing.T, env []string) {
	t.Helper()
	var ports []string
	for _, e := range env {
		if k, v, ok := strings.Cut(e, "="); ok && k == "CODEFLOW_PORT" {
			ports = append(ports, v)
		}
	}
	if len(ports) != 1 {
		t.Fatalf("exactly one CODEFLOW_PORT entry expected, got %v", ports)
	}
	n, err := strconv.Atoi(ports[0])
	if err != nil || n < codeflowPortBase || n >= codeflowPortBase+codeflowPortRange {
		t.Errorf("CODEFLOW_PORT must be a port in [8470, 9493], got %q", ports[0])
	}
}

func TestApplyComposeEnv_readsCheaseeSettings(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"docker": {"memory": "4G", "cpus": "3.0"}, "gitIdentity": {"name": "Cheasee User", "email": "c@example.com"}}`)

	stderr := testutil.CaptureStderr(t, func() {
		cmd := &mockCmd{}
		applyComposeEnv(cmd, workdir, containerName(workdir))
		for _, want := range []string{"CHEASEEPI_MEMORY=4G", "CHEASEEPI_CPUS=3.0", "HOST_GIT_NAME=Cheasee User", "HOST_GIT_EMAIL=c@example.com", "COMPOSE_PROJECT_NAME=" + composeProjectName(workdir)} {
			if !slices.Contains(cmd.env, want) {
				t.Errorf("compose env missing %q, got %v", want, cmd.env)
			}
		}
		assertOneCodeflowPort(t, cmd.env)
	})

	if !strings.Contains(stderr, "Using memory limit 4G from cheasee-settings.json") {
		t.Errorf("memory limit announcement missing, got: %q", stderr)
	}
}

func TestApplyComposeEnv_userCodeflowPortPassesThrough(t *testing.T) {
	t.Setenv("CODEFLOW_PORT", "9000")
	cmd := &mockCmd{}
	applyComposeEnv(cmd, t.TempDir(), containerName(t.TempDir()))

	if !slices.Contains(cmd.env, "CODEFLOW_PORT=9000") {
		t.Errorf("user-set CODEFLOW_PORT must pass through verbatim, got %v", cmd.env)
	}
	var count int
	for _, e := range cmd.env {
		if strings.HasPrefix(e, "CODEFLOW_PORT=") {
			count++
		}
	}
	if count != 1 {
		t.Errorf("user-set CODEFLOW_PORT must not be duplicated, got %d entries", count)
	}
}

func TestApplyComposeEnv_settingsCodeflowPortWins(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"docker": {"codeflowPort": "9100"}}`)
	t.Setenv("CODEFLOW_PORT", "9000")

	cmd := &mockCmd{}
	applyComposeEnv(cmd, workdir, containerName(workdir))

	if !slices.Contains(cmd.env, "CODEFLOW_PORT=9100") {
		t.Errorf("settings docker.codeflowPort must win over env, got %v", cmd.env)
	}
}

func TestApplyComposeEnv_hostIPPassThrough(t *testing.T) {
	// Env unset → compose env carries no CODEFLOW_HOST_IP key: the `:-`
	// default (127.0.0.1) is owned by the manifest, not the CLI, so the
	// manifest-alone path keeps working for direct compose usage.
	cmd := &mockCmd{}
	applyComposeEnv(cmd, t.TempDir(), containerName(t.TempDir()))
	for _, e := range cmd.env {
		if strings.HasPrefix(e, "CODEFLOW_HOST_IP=") {
			t.Errorf("CODEFLOW_HOST_IP must be absent when unset (manifest owns the default), got %q", e)
		}
	}

	// Env set → exactly one passthrough entry (os.Environ pass-through, not
	// stripped, not duplicated — mirrors the assertOneCodeflowPort style).
	t.Setenv("CODEFLOW_HOST_IP", "0.0.0.0")
	cmd = &mockCmd{}
	applyComposeEnv(cmd, t.TempDir(), containerName(t.TempDir()))
	var hits []string
	for _, e := range cmd.env {
		if strings.HasPrefix(e, "CODEFLOW_HOST_IP=") {
			hits = append(hits, e)
		}
	}
	if len(hits) != 1 || hits[0] != "CODEFLOW_HOST_IP=0.0.0.0" {
		t.Errorf("exactly one CODEFLOW_HOST_IP=0.0.0.0 passthrough expected, got %v", hits)
	}
}

func TestApplyComposeEnv_inheritedProjectNameReplaced(t *testing.T) {
	t.Setenv("COMPOSE_PROJECT_NAME", "user-project")
	workdir := t.TempDir()

	cmd := &mockCmd{}
	applyComposeEnv(cmd, workdir, containerName(workdir))

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
	applyComposeEnv(cmd, workdir, "my-custom-name")

	if !slices.Contains(cmd.env, "CHEASEEPI_CONTAINER=my-custom-name") {
		t.Errorf("--name override must replace the container name verbatim, got %v", cmd.env)
	}
	if !slices.Contains(cmd.env, "COMPOSE_PROJECT_NAME="+composeProjectName(workdir)) {
		t.Errorf("project name must stay repo-derived under --name override, got %v", cmd.env)
	}
}
