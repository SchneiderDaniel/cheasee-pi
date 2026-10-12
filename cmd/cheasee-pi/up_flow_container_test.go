package main

import (
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestRunUpE_autoInitDsStoreOnlyFolder(t *testing.T) {
	// A Finder-touched folder (.DS_Store only) classifies as empty and takes
	// the same init-then-stop path: init runs, no compose, no exec.
	_, workdir := newWorkspace(t)
	if err := os.WriteFile(filepath.Join(workdir, ".DS_Store"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	setUpRunMode(t, workdir, false)
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	c := stubUpFlow(t, workdir, false)
	stubInitGit(t)
	stubAutoInitDeps(t)
	exec := stubExecPIContainer(t)

	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf(".DS_Store-only folder must stop after init — no compose, got %d: %v", len(c.composeArgs), c.composeArgs)
	}
	if exec.name != "" {
		t.Errorf(".DS_Store-only folder must not exec pi, got name=%q", exec.name)
	}
}

// ──────────────────────────────────────────────
// Phase 1: workspace classifier (entity)
// ──────────────────────────────────────────────

func TestRunUpE_fullFlowRunsContainer(t *testing.T) {
	_, root := mkWorkspace(t, `{"docker": {"memory": "2G", "cpus": "2.0"}, "gitIdentity": {"name": "Test User", "email": "test@example.com"}}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)

	c := stubUpFlow(t, root, false)
	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	// start no longer scaffolds .pi/settings.json (runUpScaffold dropped).
	if _, err := os.Stat(filepath.Join(root, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Errorf("start must not scaffold .pi/settings.json, got: %v", err)
	}
	if strings.Contains(stderr, "Created .pi/settings.json") {
		t.Errorf("start must not announce a .pi/settings.json scaffold, got: %q", stderr)
	}
	// Regression: the 'starting pi' confirmation was the one-shot auto-init's
	// message — an initialized-workspace start must never print it.
	if strings.Contains(stderr, "starting pi") {
		t.Errorf("initialized-workspace start must not print the first-run confirmation, got: %q", stderr)
	}

	// Compose invoked from the version-keyed cache dir: build then up.
	if len(c.composeArgs) != 2 {
		t.Fatalf("expected build + up compose calls, got %d: %v", len(c.composeArgs), c.composeArgs)
	}
	build := c.composeArgs[0]
	up := c.composeArgs[1]
	cacheDir, err := CacheDir()
	if err != nil {
		t.Fatal(err)
	}
	composeFile := filepath.Join(cacheDir, "docker-compose.yml")
	if !slices.Contains(build, "-f") || !slices.Contains(build, composeFile) {
		t.Errorf("build must target %s, got %v", composeFile, build)
	}
	if !slices.Contains(up, "up") || !slices.Contains(up, "--remove-orphans") {
		t.Errorf("up args wrong: %v", up)
	}

	// Two sibling mounts: workspace folder + its .bare; ${PWD} never used.
	upEnv := c.composeCmds[1].env
	if !slices.Contains(upEnv, "WORKSPACE_HOST_PATH="+root) {
		t.Errorf("up env must carry WORKSPACE_HOST_PATH=%s, got %v", root, upEnv)
	}
	barePath := filepath.Join(filepath.Dir(root), ".bare")
	if !slices.Contains(upEnv, "WORKSPACE_BARE_PATH="+barePath) {
		t.Errorf("up env must carry WORKSPACE_BARE_PATH=%s, got %v", barePath, upEnv)
	}
	for _, e := range upEnv {
		if strings.Contains(e, "${PWD}") || strings.HasPrefix(e, "WORKSPACE_HOST_PATH=${PWD}") {
			t.Errorf("WORKSPACE_HOST_PATH must never use ${PWD}: %v", upEnv)
		}
	}
	// Memory + git identity from the dedicated cheasee-settings.json.
	if !slices.Contains(upEnv, "CHEASEEPI_MEMORY=2G") {
		t.Errorf("up env must carry CHEASEEPI_MEMORY from cheasee-settings.json, got %v", upEnv)
	}
	if !slices.Contains(upEnv, "HOST_GIT_NAME=Test User") {
		t.Errorf("up env must carry HOST_GIT_NAME from cheasee-settings.json gitIdentity, got %v", upEnv)
	}

	// Final exec descends to the workspace root target.
	if exec.name != containerName(root) || exec.target != "/workspaces/main" {
		t.Errorf("exec must target -w /workspaces/main in container %q, got name=%q target=%q", containerName(root), exec.name, exec.target)
	}

	// The per-repo CodeFlow URL is printed after start.
	if !strings.Contains(stderr, "CodeFlow: http://localhost:") {
		t.Errorf("start must print the CodeFlow URL, got: %q", stderr)
	}
	if !strings.Contains(stderr, "repo=local/workspace&run=1") {
		t.Errorf("CodeFlow URL must carry the workspace params, got: %q", stderr)
	}
	// The URL line is followed by the always-on description trailer.
	if !strings.Contains(stderr, "Optional browser sidecar") {
		t.Errorf("start must print the CodeFlow hint trailer, got: %q", stderr)
	}

	// The resolved CodeFlow port must reach the exec env (derived case: no
	// codeflowPort setting, no host CODEFLOW_PORT) so the in-container hint
	// matches the actually-bound port — and it must equal the printed URL.
	port := exec.env["CODEFLOW_PORT"]
	if port == "" {
		t.Errorf("exec env must carry CODEFLOW_PORT, got %v", exec.env)
	} else if !strings.Contains(stderr, "http://localhost:"+port+"/") {
		t.Errorf("exec env CODEFLOW_PORT=%s must match the printed CodeFlow URL, stderr: %q", port, stderr)
	}
}
