package main

import (
	"context"
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// runUpE end-to-end flow use-case tests: start gate, dry-run, auto-init
// (empty-folder) and initialized-workspace start scenarios. The shared
// fixtures moved to up_helpers_test.go.
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// Phase 1: start gate use cases
// ──────────────────────────────────────────────

func TestEnsureStackUp_neverPullsAndEveryUpUsesPullNever(t *testing.T) {
	root, name, _, c := stackFixture(t)
	c.states = nil
	c.imageRefs = map[string]bool{}

	if err := ensureStackUp(context.Background(), t.TempDir(), root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	for _, args := range c.composeArgs {
		if slices.Contains(args, "pull") {
			t.Errorf("start must never run a compose pull, got %v", args)
		}
		if slices.Contains(args, "up") {
			i := slices.Index(args, "--pull")
			if i < 0 || i+1 >= len(args) || args[i+1] != "never" || !slices.Contains(args, "--no-build") {
				t.Errorf("create must use --pull never and --no-build, got %v", args)
			}
		}
	}
}

func TestRunUpE_stateProbeErrorNeverExecs(t *testing.T) {
	root, _ := reusedStack(t)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	stubLookPath(t, func(string) (string, error) { return "/usr/bin/docker", nil })

	var composeCalls int
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "git" {
			return &mockCmd{}
		}
		if slices.Contains(arg, "compose") {
			composeCalls++
			return &mockCmd{}
		}
		if len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("24.0.9"), nil }}
		}
		if argHas(arg, "{{json .}}") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("{}"), nil }}
		}
		if argHas(arg, "{{.State}}") {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, exitStatusError(2) }}
		}
		return &mockCmd{}
	})

	err := runUpE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "check container:") || !strings.Contains(err.Error(), "docker ps:") {
		t.Fatalf("state-probe error must surface, got %v", err)
	}
	if composeCalls != 0 || exec.name != "" {
		t.Errorf("failed probe must skip compose and exec; compose=%d exec=%q", composeCalls, exec.name)
	}
}

func TestEnsureStackUp_commitRecordOnlyForAgentBuild(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	record := cheaseeCommitCachePath(cacheDir, cheaseeImageRef(root))
	c.states = map[string]string{services[0].container: "running"}
	c.imageRefs = map[string]bool{services[1].image: false, services[2].image: true}
	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	if _, err := os.Stat(record); !os.IsNotExist(err) {
		t.Errorf("sidecar-only build must not record the agent commit, got %v", err)
	}

	c2 := stubReadyFlow(t, root, func(context.Context, []string) runner { return &mockCmd{} })
	c2.states = nil
	c2.imageRefs = map[string]bool{}
	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	if _, err := os.Stat(record); err != nil {
		t.Errorf("agent build must record the baked commit, got %v", err)
	}
}

func TestEnsureStackUp_noImagesPrintsFirstBuildNoticeOnce(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	c.states = nil
	c.imageRefs = map[string]bool{}

	stderr := testutil.CaptureStderr(t, func() {
		if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
			t.Fatalf("ensureStackUp: %v", err)
		}
	})
	if len(c.composeArgs) != 2 {
		t.Fatalf("all images absent → one build + one create, got %v", c.composeArgs)
	}
	build := c.composeArgs[0]
	if !slices.Equal(build[len(build)-3:], []string{"cheasee-pi", "codeflow", "ui"}) {
		t.Errorf("all-services build must target the stack in order, got %v", build)
	}
	if n := strings.Count(stderr, "First start downloads"); n != 1 {
		t.Errorf("notice must appear exactly once, got %d in %q", n, stderr)
	}
	i, j := strings.Index(stderr, "First start downloads"), strings.Index(stderr, "Building container image...")
	if i < 0 || j < 0 || i > j {
		t.Errorf("notice (idx %d) must precede the build label (idx %d), stderr %q", i, j, stderr)
	}
}

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
	// Dry-run returns before the CodeFlow phase: no URL, no trailer.
	if strings.Contains(stderr, "CodeFlow") {
		t.Errorf("dry-run must not print any CodeFlow text, got: %q", stderr)
	}
	// Dry-run also returns before the launch block: no first-build gate, no
	// notice, no cheatsheet (a dry-run on a fresh machine must not kick off
	// a 10-minute image build nor its probe).
	if c.imageGates != 0 {
		t.Errorf("dry-run must not run the image-presence gate, got %d", c.imageGates)
	}
	if strings.Contains(stderr, "First start downloads") {
		t.Errorf("dry-run must not print the first-build notice, got: %q", stderr)
	}
	if strings.Contains(stderr, "inside pi:") {
		t.Errorf("dry-run must not print the launch cheatsheet, got: %q", stderr)
	}
}

func TestRunUpE_autoInitStopsAfterInit(t *testing.T) {
	// Empty folder → runUpE runs init and STOPS (init never launches pi): no
	// compose, no docker exec. The next-step hint tells the user to re-run
	// start — the initialized-workspace start path is covered separately.
	_, workdir := newWorkspace(t)
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
	// Auto-init shares runInit byte-identically — the workflow overview must
	// appear here just as it does for `cheasee-pi init`.
	if !strings.Contains(stderr, "init runs only in an empty directory") {
		t.Errorf("auto-init must print the same workflow overview as init, got: %q", stderr)
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
	// Auto-init stops before the launch block: no cheatsheet.
	if strings.Contains(stderr, "inside pi:") {
		t.Errorf("auto-init stop must not print the launch cheatsheet, got: %q", stderr)
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
	_, workdir := newWorkspace(t)
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
	// init fails in the API-key phase → error wrapped with plain empty-folder
	// wording (no "auto-init" jargon) and the freshly cloned residue (worktree
	// + .bare) is cleaned to an empty folder; no compose, no exec.
	_, workdir := newWorkspace(t)
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
		if err == nil || !strings.Contains(err.Error(), "cheasee-pi detected an empty folder and tried to initialize it, but") {
			t.Fatalf("expected the empty-folder init wrap, got %v", err)
		}
		if strings.Contains(err.Error(), "auto-init failed") {
			t.Errorf("wrap must not use the 'auto-init failed' jargon, got %v", err)
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

func TestRunUpE_autoInitDockerMissingExplainsWhy(t *testing.T) {
	// Bare `cheasee-pi` in an empty folder with Docker missing is the
	// first-run failure a new user hits: the error must explain what
	// cheasee-pi is, why Docker is required, where to install it, and the next
	// step — wrapped in the plain empty-folder wording, never 'auto-init
	// failed'. The announce line stays; init aborts before touching auth,
	// compose, or exec.
	_, workdir := newWorkspace(t)
	setUpRunMode(t, workdir, false)
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubLookPath(t, func(_ string) (string, error) { return "", fmt.Errorf("executable not found in $PATH") })
	exec := stubExecPIContainer(t)
	var dockerCalls int
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "docker" {
			dockerCalls++
		}
		return saved(ctx, name, arg...)
	})

	stderr := testutil.CaptureStderr(t, func() {
		err := runUpE(&cobra.Command{}, nil)
		if err == nil {
			t.Fatal("expected docker-missing error, got nil")
		}
		for _, want := range []string{
			"cheasee-pi detected an empty folder and tried to initialize it, but",
			"Docker is not installed",
			"runs the pi coding agent inside a Docker container",
			"https://docs.docker.com/engine/install/",
		} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("error should explain %q, got %v", want, err)
			}
		}
		if strings.Contains(err.Error(), "auto-init failed") {
			t.Errorf("wrap must not use the 'auto-init failed' jargon, got %v", err)
		}
	})
	if !strings.Contains(stderr, "is empty — running `cheasee-pi init`") {
		t.Errorf("empty folder must still announce auto-init, got: %q", stderr)
	}
	if authJSONExists(t) {
		t.Error("docker-missing auto-init must not write auth.json")
	}
	if exec.name != "" || exec.target != "" {
		t.Errorf("docker-missing auto-init must not exec pi, got name=%q target=%q", exec.name, exec.target)
	}
	if dockerCalls != 0 {
		t.Errorf("docker-missing auto-init must fail before any docker invocation, got %d", dockerCalls)
	}
}

func TestRunUpE_autoInitPreCancelledFailsFast(t *testing.T) {
	// A pre-cancelled parent ctx propagates into the 5-min initTimeout child
	// ctx → auto-init fails fast with the ctx error; no compose, no exec.
	_, workdir := newWorkspace(t)
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
