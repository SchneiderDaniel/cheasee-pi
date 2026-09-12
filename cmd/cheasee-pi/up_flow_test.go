package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// runUpE end-to-end flow use-case tests: start gate, dry-run, auto-init
// (empty-folder) and initialized-workspace start scenarios. The shared
// fixtures moved to up_helpers_test.go.
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// Phase 1: start gate use cases
// ──────────────────────────────────────────────

func TestRunUpE_nonInitializedRefusedNoDockerCalls(t *testing.T) {
	workdir := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workdir, "somefile.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	setUpRun(t, workdir)

	var dockerCalls int
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	stubRunCommandContext(t, func(_ context.Context, name string, _ ...string) runner {
		if name == "docker" {
			dockerCalls++
		}
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("false"), nil }}
	})

	err := runUpE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "not initialized") {
		t.Fatalf("expected refusal mentioning 'not initialized', got %v", err)
	}
	if !strings.Contains(err.Error(), "cheasee-pi init") {
		t.Errorf("refusal must mention `cheasee-pi init`, got %v", err)
	}
	if dockerCalls != 0 {
		t.Errorf("non-initialized cwd must be refused before any docker invocation, got %d", dockerCalls)
	}
}

func TestRunUpE_dryRunOnEmptyFolder(t *testing.T) {
	workdir := t.TempDir()
	setUpRun(t, workdir)

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	// Dry-run on empty prints what would happen and exits — touches nothing.
	if !strings.Contains(stderr, "would run `cheasee-pi init`") {
		t.Errorf("dry-run on empty must announce the would-be init, got: %q", stderr)
	}
	if !strings.Contains(stderr, "again to launch pi") {
		t.Errorf("dry-run on empty must point at re-running start, got: %q", stderr)
	}
	if _, err := os.Stat(filepath.Join(workdir, "cheasee-settings.json")); !os.IsNotExist(err) {
		t.Errorf("dry-run must not scaffold cheasee-settings.json: %v", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(workdir), ".bare")); !os.IsNotExist(err) {
		t.Errorf("dry-run must not clone a .bare: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Errorf("dry-run must not scaffold .pi/settings.json: %v", err)
	}
}

func TestRunUpE_dryRunOnInitialized(t *testing.T) {
	root := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, root, `{}`)
	setUpRun(t, root)

	c := stubUpFlow(t, root, false)
	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	// Existing dry-run contract intact: env vars + docker command, nothing
	// scaffolded or invoked.
	if len(c.composeArgs) != 0 {
		t.Errorf("dry-run must not invoke compose, got %d invocations: %v", len(c.composeArgs), c.composeArgs)
	}
	if !strings.Contains(stderr, "Env vars to be injected") {
		t.Errorf("dry-run must print env vars, got: %q", stderr)
	}
	if !strings.Contains(stderr, "Docker command") || !strings.Contains(stderr, "-w /workspaces/main") {
		t.Errorf("dry-run must print the docker command at -w /workspaces/main, got: %q", stderr)
	}
}

func TestRunUpE_autoInitStopsAfterInit(t *testing.T) {
	// Empty folder → runUpE runs init and STOPS (init never launches pi): no
	// compose, no docker exec. The next-step hint tells the user to re-run
	// start — the initialized-workspace start path is covered separately.
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	setUpRunMode(t, workdir, false)
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	// Stub order matters: stubUpFlow installs the single runCommandContext
	// seam and must sit before stubInitGit so init's clone chains to
	// stubUpFlow's docker/version handlers.
	stubDockerCheck(t, nil, "24.0.9", nil)
	c := stubUpFlow(t, workdir, false)
	stubInitGit(t)
	stubAutoInitDeps(t)
	exec := stubExecPIContainer(t)

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	if !strings.Contains(stderr, "running `cheasee-pi init`") {
		t.Errorf("empty folder must announce auto-init, got: %q", stderr)
	}
	if !strings.Contains(stderr, "Cloned (bare + worktree)") {
		t.Errorf("user should see the clone notice during auto-init, got: %q", stderr)
	}
	// Init never launches pi: the standalone next-step hint is printed and the
	// invocation ends — no compose, no exec.
	if !strings.Contains(stderr, "Next step:") || !strings.Contains(stderr, "cheasee-pi start") {
		t.Errorf("auto-init must hand off to a second `cheasee-pi start`, got: %q", stderr)
	}
	// Init artifacts: worktree checked out at the branch-named leaf, its
	// sibling .bare, settings inside the leaf.
	if _, err := os.Stat(filepath.Join(workdir, "main", "cheasee-settings.json")); err != nil {
		t.Errorf("auto-init must scaffold cheasee-settings.json in the worktree leaf: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, ".bare")); err != nil {
		t.Errorf("auto-init must bare-clone into <workdir>/.bare: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, "main", ".git")); err != nil {
		t.Errorf("auto-init must add the main worktree at <workdir>/main: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("auto-init must save auth.json")
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("auto-init must stop after init — compose must not run, got %d invocations: %v", len(c.composeArgs), c.composeArgs)
	}
	if exec.name != "" || exec.target != "" {
		t.Errorf("auto-init must not exec pi, got name=%q target=%q", exec.name, exec.target)
	}
}

func TestRunUpE_autoInitMatchesRunInit(t *testing.T) {
	// start-triggered init (runUpE empty branch) and runInit share the
	// newInitDeps factory → byte-identical cheasee-settings.json artifacts.
	parentA := t.TempDir()
	dirA := filepath.Join(parentA, "ws")
	if err := os.MkdirAll(dirA, 0755); err != nil {
		t.Fatal(err)
	}
	setUpRunMode(t, dirA, false)
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	stubUpFlow(t, dirA, false)
	stubInitGit(t)
	stubAutoInitDeps(t)
	stubExecPIContainer(t)

	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}
	settingsA, err := os.ReadFile(filepath.Join(dirA, "main", "cheasee-settings.json"))
	if err != nil {
		t.Fatalf("read start-triggered settings: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dirA, ".bare")); err != nil {
		t.Errorf("start-triggered init must bare-clone into <workdir>/.bare: %v", err)
	}

	// Same flow via runInit (the `cheasee-pi init` path) on a second folder.
	dirB := filepath.Join(t.TempDir(), "ws")
	if err := os.MkdirAll(dirB, 0755); err != nil {
		t.Fatal(err)
	}
	if err := runInit(context.Background(), initDepsWithRepoURL(t, dirB)); err != nil {
		t.Fatalf("runInit: %v", err)
	}
	settingsB, err := os.ReadFile(filepath.Join(dirB, "main", "cheasee-settings.json"))
	if err != nil {
		t.Fatalf("read runInit settings: %v", err)
	}
	if string(settingsA) != string(settingsB) {
		t.Errorf("start-triggered init and runInit must produce byte-identical cheasee-settings.json:\nA: %s\nB: %s", settingsA, settingsB)
	}
}

func TestRunUpE_autoInitWithoutMarkerThenNextRunRefuses(t *testing.T) {
	// init returns nil but leaves no settings marker (ConfirmFn deletes
	// cheasee-settings.json during the API-key phase and declines): the empty-
	// folder branch stops after init (it no longer re-resolves the workspace),
	// so the residue lingers — the NEXT start classifies the folder as
	// non-initialized and refuses. No compose, no exec.
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	setUpRunMode(t, workdir, false)
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	c := stubUpFlow(t, workdir, false)
	stubInitGit(t)
	exec := stubExecPIContainer(t)
	saved := newInitDeps
	newInitDeps = func(wd string) InitDeps {
		deps := initDepsWithRepoURL(t, wd)
		deps.ConfirmFn = func(title string) (bool, error) {
			if strings.Contains(title, "Configure API keys") {
				_ = os.Remove(filepath.Join(wd, "main", "cheasee-settings.json"))
				return false, nil
			}
			if strings.Contains(title, "Add a custom skill repository") {
				return false, nil
			}
			return true, nil
		}
		return deps
	}
	t.Cleanup(func() { newInitDeps = saved })

	// First start: empty folder → init runs, then stops. No compose/exec even
	// though the marker is gone (init reported success).
	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("first runUpE: %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("post-init stop must never reach compose, got %d invocations: %v", len(c.composeArgs), c.composeArgs)
	}
	if exec.name != "" {
		t.Errorf("post-init stop must never exec pi, got name=%q", exec.name)
	}

	// Second start: non-empty (worktree + .bare residue) without the settings
	// marker → refused with the empty-folder hint, message includes the error
	// the user asked for ('run in an empty folder').
	err := runUpE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "not initialized") {
		t.Fatalf("second runUpE must refuse the non-initialized residue, got %v", err)
	}
	if !strings.Contains(err.Error(), "cheasee-pi init") || !strings.Contains(err.Error(), "empty folder") {
		t.Errorf("refusal should point at init in an empty folder, got %v", err)
	}
}

func TestRunUpE_autoInitFailureSurfaces(t *testing.T) {
	// init fails in the API-key phase → error wrapped 'auto-init failed' and
	// the freshly cloned residue (worktree + .bare) is cleaned to an empty
	// folder; no compose, no exec.
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	setUpRunMode(t, workdir, false)
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	c := stubUpFlow(t, workdir, false)
	stubInitGit(t)
	stubExecPIContainer(t)
	saved := newInitDeps
	newInitDeps = func(wd string) InitDeps {
		deps := initDepsWithRepoURL(t, wd)
		deps.ConfirmFn = mockConfirmFn(false, fmt.Errorf("declined"))
		return deps
	}
	t.Cleanup(func() { newInitDeps = saved })

	stderr := testutil.CaptureStderr(t, func() {
		err := runUpE(&cobra.Command{}, nil)
		if err == nil || !strings.Contains(err.Error(), "auto-init failed") {
			t.Fatalf("expected 'auto-init failed' wrap, got %v", err)
		}
		// The first post-clone prompt is now the skill-repo phase (Phase 6b,
		// before the API-key phase) — the failure surfaces there.
		if !strings.Contains(err.Error(), "skill repo setup") {
			t.Errorf("error should carry the underlying skill-repo setup failure, got %v", err)
		}
	})
	if !strings.Contains(stderr, "removing incomplete workspace residue") {
		t.Errorf("cleanup must be announced to stderr, got: %q", stderr)
	}
	// Residue cleaned: worktree leaf + .bare removed, init folder left empty.
	if _, statErr := os.Stat(filepath.Join(workdir, "main")); !os.IsNotExist(statErr) {
		t.Errorf("failed auto-init must remove the worktree residue: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(workdir, ".bare")); !os.IsNotExist(statErr) {
		t.Errorf("failed auto-init must remove .bare: %v", statErr)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("failed init must not reach compose, got %d invocations: %v", len(c.composeArgs), c.composeArgs)
	}
}

func TestRunUpE_autoInitPreCancelledFailsFast(t *testing.T) {
	// A pre-cancelled parent ctx propagates into the 5-min initTimeout child
	// ctx → auto-init fails fast with the ctx error; no compose, no exec.
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	setUpRunMode(t, workdir, false)
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	c := stubUpFlow(t, workdir, false)
	stubInitGit(t)
	stubAutoInitDeps(t)
	stubExecPIContainer(t)

	cmd := &cobra.Command{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cmd.SetContext(ctx)

	err := runUpE(cmd, nil)
	if err == nil || !strings.Contains(err.Error(), "context canceled") {
		t.Fatalf("expected fast ctx cancellation, got %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("cancelled auto-init must not reach compose, got %d invocations", len(c.composeArgs))
	}
}

func TestRunUpE_autoInitDsStoreOnlyFolder(t *testing.T) {
	// A Finder-touched folder (.DS_Store only) classifies as empty and takes
	// the same init-then-stop path: init runs, no compose, no exec.
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
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

func TestRunUpE_settingsButNoBareFailsClosed(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	testutil.WriteCheaseeSettingsFile(t, root, `{"docker": {"memory": "2G"}}`)
	// NO parent/.bare — corrupt workspace; compose must never be invoked
	// (Docker's create_host_path would otherwise create a stray host dir).
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)

	var composeCalls int
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "compose") {
			composeCalls++
			return &mockCmd{}
		}
		if name == "docker" && len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("24.0.9"), nil }}
		}
		if name == "docker" && slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		return &mockCmd{}
	})

	err := runUpE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "corrupt") {
		t.Fatalf("expected fail-closed error mentioning the corrupt workspace, got %v", err)
	}
	if !strings.Contains(err.Error(), "cheasee-pi init") {
		t.Errorf("error must carry the recovery hint, got %v", err)
	}
	if composeCalls != 0 {
		t.Errorf("compose must never be invoked when .bare is missing, got %d", composeCalls)
	}
}

func TestRunUpE_existingCheaseeSettingsUntouched(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	legacy := `{"defaultProvider": "openai", "docker": {"memory": ""}}`
	testutil.WriteCheaseeSettingsFile(t, root, legacy)
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)

	c := stubUpFlow(t, root, false)
	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}

	// Never-overwrite rule: byte-identical after start.
	after, err := os.ReadFile(filepath.Join(root, "cheasee-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != legacy {
		t.Errorf("existing cheasee-settings.json must be byte-preserved:\n got %q\nwant %q", after, legacy)
	}
	// Empty docker.memory → no CHEASEEPI_MEMORY env.
	upEnv := c.composeCmds[1].env
	for _, e := range upEnv {
		if strings.HasPrefix(e, "CHEASEEPI_MEMORY=") {
			t.Errorf("no memory limit configured → no CHEASEEPI_MEMORY, got %v", upEnv)
		}
	}
}

func TestRunUpE_subdirExecTarget(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	sub := filepath.Join(root, "sub", "dir")
	if err := os.MkdirAll(sub, 0755); err != nil {
		t.Fatal(err)
	}
	setUpRun(t, sub)

	c := stubUpFlow(t, root, false)
	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	// Dry-run prints the mounted exec target with the relative cwd.
	if !strings.Contains(stderr, "-w /workspaces/main/sub/dir") {
		t.Errorf("dry-run must exec at -w /workspaces/main/sub/dir, got: %q", stderr)
	}
	// Dry-run touches nothing: no compose, no .pi scaffold.
	if _, err := os.Stat(filepath.Join(root, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Errorf("dry-run must not scaffold settings, got: %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("dry-run must not invoke compose, got %d: %v", len(c.composeArgs), c.composeArgs)
	}
}

func TestRunUpE_subdirFullFlowMountsToplevel(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	sub := filepath.Join(root, "sub", "dir")
	if err := os.MkdirAll(sub, 0755); err != nil {
		t.Fatal(err)
	}
	setUpRunMode(t, sub, false)
	exec := stubExecPIContainer(t)

	c := stubUpFlow(t, root, false)
	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}

	// Toplevel is mounted; exec descends to the relative cwd.
	if exec.target != "/workspaces/main/sub/dir" {
		t.Errorf("exec must target -w /workspaces/main/sub/dir, got %q", exec.target)
	}
	// start never scaffolds .pi/settings.json anymore.
	if _, err := os.Stat(filepath.Join(root, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Errorf("start must not scaffold .pi/settings.json at the workspace root: %v", err)
	}
	// Compose still invoked with the cache-dir compose file and the toplevel mount.
	cacheDir, err := CacheDir()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(c.composeArgs[0], " "), cacheDir) {
		t.Errorf("compose must run from the cache dir, got %v", c.composeArgs[0])
	}
	upEnv := c.composeCmds[1].env
	if !slices.Contains(upEnv, "WORKSPACE_HOST_PATH="+root) {
		t.Errorf("up env must carry WORKSPACE_HOST_PATH=%s (toplevel, not cwd), got %v", root, upEnv)
	}
}

func TestRunUpE_containerRunningSkipsComposeUp(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)

	c := stubUpFlow(t, root, true)
	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("running container must skip compose up, got %d invocations: %v", len(c.composeArgs), c.composeArgs)
	}
	// Orphan scan + exec still run against the running container.
	if exec.name != containerName(root) {
		t.Errorf("exec must still run against the running container, got name=%q", exec.name)
	}
}

func TestRunUpE_selinuxRelabelToggle(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)

	// Unset (default): no VOLUME_RELABEL — bind mounts unchanged.
	t.Setenv("CHEASEEPI_SELINUX_RELABEL", "")
	c := stubUpFlow(t, root, false)
	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}
	upEnv := c.composeCmds[1].env
	for _, e := range upEnv {
		if strings.HasPrefix(e, "VOLUME_RELABEL=") {
			t.Errorf("unset toggle must not set VOLUME_RELABEL, got %v", upEnv)
		}
	}

	// CHEASEEPI_SELINUX_RELABEL=1 → :Z appended to every bind mount.
	t.Setenv("CHEASEEPI_SELINUX_RELABEL", "1")
	c2 := stubUpFlow(t, root, false)
	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}
	upEnv2 := c2.composeCmds[1].env
	if !slices.Contains(upEnv2, "VOLUME_RELABEL=:Z") {
		t.Errorf("toggle=1 must set VOLUME_RELABEL=:Z, got %v", upEnv2)
	}
}
