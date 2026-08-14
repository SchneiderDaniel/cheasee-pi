package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// runUpE use-case tests (empty-folder auto-init + workspace gate restructure)
// ──────────────────────────────────────────────

// upCapture records the docker compose invocations and their env during a
// runUpE test.
type upCapture struct {
	composeArgs [][]string
	composeCmds []*mockCmd
}

// stubUpFlow stubs the docker+git seams for runUpE use-case tests: git
// resolves to root (relCwd derived from the physical workdir), docker ps
// reports the container running state, compose invocations are captured.
func stubUpFlow(t *testing.T, root string, running bool) *upCapture {
	t.Helper()
	c := &upCapture{}
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "git" {
			if slices.Contains(arg, "--is-inside-work-tree") {
				return &mockCmd{outputFn: func() ([]byte, error) { return []byte("true"), nil }}
			}
			if slices.Contains(arg, "--show-prefix") {
				// Mirror git: trailing slash when non-empty, "" at toplevel.
				workdir := ""
				for i, a := range arg {
					if a == "-C" && i+1 < len(arg) {
						workdir = arg[i+1]
					}
				}
				prefix := ""
				if rel, err := filepath.Rel(root, workdir); err == nil && rel != "." {
					prefix = filepath.ToSlash(rel) + "/"
				}
				return &mockCmd{outputFn: func() ([]byte, error) { return []byte(prefix), nil }}
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(root), nil }}
		}
		if name == "docker" && slices.Contains(arg, "compose") {
			m := &mockCmd{}
			c.composeArgs = append(c.composeArgs, arg)
			c.composeCmds = append(c.composeCmds, m)
			return m
		}
		if name == "docker" && len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("24.0.9"), nil }}
		}
		return &mockCmd{} // docker info
	})
	stubExecCommand(t, func(name string, arg ...string) cmdIface {
		if name == "git" {
			// Real .bare config read for identity derivation (fixture remotes).
			return exec.Command(name, arg...)
		}
		if slices.Contains(arg, "ps") {
			names := ""
			if running {
				names = containerName(root)
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(names), nil }}
		}
		if slices.Contains(arg, "inspect") {
			// Ready-marker healthcheck: entrypoint setup assumed complete.
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		return &mockCmd{}
	})
	return c
}

// setUpRun pins the package state a runUpE test needs: hermetic config/cache
// homes, hermetic git identity, dry-run mode, and the workdir flag.
func setUpRun(t *testing.T, workdir string) {
	setUpRunMode(t, workdir, true)
}

// setUpRunMode is setUpRun with an explicit dry-run flag. Non-dry-run tests
// additionally stub execPIContainer so the final docker exec never runs.
func setUpRunMode(t *testing.T, workdir string, dryRun bool) {
	t.Helper()
	testutil.SetGitConfig(t, testGitIdentityConfig) // needs git on PATH — do this before pinPassthroughEnv
	origPath := os.Getenv("PATH")
	pinPassthroughEnv(t)
	// pinPassthroughEnv points PATH at a dir with only a failing gh shim;
	// re-append the original PATH so the real git binary stays resolvable
	// (the gh shim still wins, keeping GH_TOKEN extraction hermetic).
	t.Setenv("PATH", os.Getenv("PATH")+string(os.PathListSeparator)+origPath)
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	savedWorkdir := upWorkdir
	savedDryRun := upDryRun
	savedName := upName
	upWorkdir = workdir
	upDryRun = dryRun
	upName = "cheasee-pi"
	t.Cleanup(func() {
		upWorkdir = savedWorkdir
		upDryRun = savedDryRun
		upName = savedName
	})
}

// upExecCapture records a stubbed execPIContainer invocation.
type upExecCapture struct {
	name   string
	env    map[string]string
	target string
}

// stubExecPIContainer overrides the exec seam so non-dry-run runUpE tests
// observe the final docker exec invocation instead of running it.
func stubExecPIContainer(t *testing.T) *upExecCapture {
	t.Helper()
	c := &upExecCapture{}
	saved := execPIContainer
	execPIContainer = func(name string, env map[string]string, target string) error {
		c.name = name
		c.env = env
		c.target = target
		return nil
	}
	t.Cleanup(func() { execPIContainer = saved })
	return c
}

// mkWorkspace creates an initialized workspace fixture: parent + ws (the
// worktree root) with cheasee-settings.json, plus the sibling parent/.bare.
func mkWorkspace(t *testing.T, settingsContent string) (parent, root string) {
	t.Helper()
	parent = t.TempDir()
	root = filepath.Join(parent, "ws")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(parent, ".bare"), 0755); err != nil {
		t.Fatal(err)
	}
	testutil.WriteCheaseeSettingsFile(t, root, settingsContent)
	return parent, root
}

// stubAutoInitDeps replaces the shared newInitDeps factory so start-triggered
// init runs with the stubbed OAuth/prompt boundaries (the same seam runInitE
// tests use) instead of a real device flow or TTY.
func stubAutoInitDeps(t *testing.T) {
	t.Helper()
	saved := newInitDeps
	newInitDeps = func(workdir string) InitDeps {
		return initDepsWithRepoURL(t, workdir)
	}
	t.Cleanup(func() { newInitDeps = saved })
}

func TestClassifyWorkspace_empty(t *testing.T) {
	state, err := classifyWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("classifyWorkspace: %v", err)
	}
	if state != WorkspaceEmpty {
		t.Errorf("empty dir → WorkspaceEmpty, got %v", state)
	}
}

func TestClassifyWorkspace_dsStoreOnly(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".DS_Store"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	state, err := classifyWorkspace(dir)
	if err != nil {
		t.Fatalf("classifyWorkspace: %v", err)
	}
	if state != WorkspaceEmpty {
		t.Errorf(".DS_Store-only dir → WorkspaceEmpty, got %v", state)
	}
}

func TestClassifyWorkspace_initialized(t *testing.T) {
	dir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, dir, `{}`)
	state, err := classifyWorkspace(dir)
	if err != nil {
		t.Fatalf("classifyWorkspace: %v", err)
	}
	if state != WorkspaceInitialized {
		t.Errorf("cheasee-settings.json present → WorkspaceInitialized, got %v", state)
	}
}

func TestClassifyWorkspace_nonEmptyRefuse(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	state, err := classifyWorkspace(dir)
	if err != nil {
		t.Fatalf("classifyWorkspace: %v", err)
	}
	if state != WorkspaceRefuse {
		t.Errorf("non-empty w/o settings → WorkspaceRefuse, got %v", state)
	}
}

func TestFindWorkspaceRoot_fromSubdir(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	if err := os.MkdirAll(filepath.Join(root, "sub", "dir"), 0755); err != nil {
		t.Fatal(err)
	}
	testutil.WriteCheaseeSettingsFile(t, root, `{}`)

	got, ok := findWorkspaceRoot(filepath.Join(root, "sub", "dir"))
	if !ok || got != root {
		t.Errorf("findWorkspaceRoot(subdir) = %q, %v; want %q, true", got, ok, root)
	}
}

func TestFindWorkspaceRoot_notFound(t *testing.T) {
	if _, ok := findWorkspaceRoot(t.TempDir()); ok {
		t.Error("no ancestor with cheasee-settings.json → not found")
	}
}

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
	if !strings.Contains(stderr, "one invocation") {
		t.Errorf("dry-run on empty must describe the one-shot continuation, got: %q", stderr)
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

func TestRunUpE_autoInitEmptyFolder(t *testing.T) {
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	setUpRunMode(t, workdir, false)
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	// Stub order matters: stubUpFlow installs the execCommand/runCommandContext
	// seams the continuation needs and must sit before stubInitGit so init's
	// clone chains to stubUpFlow's docker/version handlers.
	stubDockerCheck(t, nil, "24.0.9", nil)
	c := stubUpFlow(t, workdir, false)
	stubInitGit(t)
	stubAutoInitDeps(t)
	exec := stubExecPIContainer(t)
	// Ordering pin: the one-shot confirmation must print BEFORE the blocking
	// exec (a post-exec message would only appear when the session ends).
	savedExec := execPIContainer
	execPIContainer = func(name string, env map[string]string, target string) error {
		fmt.Fprintf(os.Stderr, "EXEC-INVOKED\n")
		return savedExec(name, env, target)
	}

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	if !strings.Contains(stderr, "running `cheasee-pi init` first") {
		t.Errorf("empty folder must announce auto-init, got: %q", stderr)
	}
	if !strings.Contains(stderr, "Cloned (bare + worktree)") {
		t.Errorf("user should see the clone notice during auto-init, got: %q", stderr)
	}
	if strings.Contains(stderr, "run `cheasee-pi start` again") {
		t.Errorf("one-shot start must not hand off to a second start, got: %q", stderr)
	}
	if strings.Contains(stderr, "Next step:") {
		t.Errorf("start-triggered init must not print the standalone next-step hint, got: %q", stderr)
	}
	if !strings.Contains(stderr, "starting pi") {
		t.Errorf("one-shot start must confirm pi is starting, got: %q", stderr)
	}
	if i, j := strings.Index(stderr, "starting pi"), strings.Index(stderr, "EXEC-INVOKED"); i < 0 || j < 0 || i > j {
		t.Errorf("'starting pi' confirmation must precede the exec invocation, stderr: %q", stderr)
	}
	// Init artifacts: worktree checked out, sibling .bare, settings at root.
	if _, err := os.Stat(filepath.Join(workdir, "cheasee-settings.json")); err != nil {
		t.Errorf("auto-init must scaffold cheasee-settings.json: %v", err)
	}
	if _, err := os.Stat(filepath.Join(parent, ".bare")); err != nil {
		t.Errorf("auto-init must bare-clone into <parent>/.bare: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, ".git")); err != nil {
		t.Errorf("auto-init must add the main worktree: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("auto-init must save auth.json")
	}

	// Continuation: compose build + up from the cache dir with the two sibling
	// mounts, then exec into the derived container.
	if len(c.composeArgs) != 2 {
		t.Errorf("one-shot start must build + up via compose, got %d invocations: %v", len(c.composeArgs), c.composeArgs)
	}
	cacheDir, err := CacheDir()
	if err != nil {
		t.Fatal(err)
	}
	composeFile := filepath.Join(cacheDir, "docker-compose.yml")
	if len(c.composeArgs) == 2 && (!slices.Contains(c.composeArgs[0], composeFile) || !slices.Contains(c.composeArgs[1], "up")) {
		t.Errorf("compose must build + up from the cache dir, got %v", c.composeArgs)
	}
	if exec.name != containerName(workdir) || exec.target != "/workspaces/main" {
		t.Errorf("exec must target -w /workspaces/main in container %q, got name=%q target=%q", containerName(workdir), exec.name, exec.target)
	}
	upEnv := c.composeCmds[1].env
	if !slices.Contains(upEnv, "WORKSPACE_HOST_PATH="+workdir) {
		t.Errorf("up env must carry WORKSPACE_HOST_PATH=%s, got %v", workdir, upEnv)
	}
	if !slices.Contains(upEnv, "WORKSPACE_BARE_PATH="+filepath.Join(parent, ".bare")) {
		t.Errorf("up env must carry WORKSPACE_BARE_PATH=%s, got %v", filepath.Join(parent, ".bare"), upEnv)
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
	settingsA, err := os.ReadFile(filepath.Join(dirA, "cheasee-settings.json"))
	if err != nil {
		t.Fatalf("read start-triggered settings: %v", err)
	}
	if _, err := os.Stat(filepath.Join(parentA, ".bare")); err != nil {
		t.Errorf("start-triggered init must bare-clone into <parent>/.bare: %v", err)
	}

	// Same flow via runInit (the `cheasee-pi init` path) on a second folder.
	dirB := filepath.Join(t.TempDir(), "ws")
	if err := os.MkdirAll(dirB, 0755); err != nil {
		t.Fatal(err)
	}
	if err := runInit(context.Background(), initDepsWithRepoURL(t, dirB)); err != nil {
		t.Fatalf("runInit: %v", err)
	}
	settingsB, err := os.ReadFile(filepath.Join(dirB, "cheasee-settings.json"))
	if err != nil {
		t.Fatalf("read runInit settings: %v", err)
	}
	if string(settingsA) != string(settingsB) {
		t.Errorf("start-triggered init and runInit must produce byte-identical cheasee-settings.json:\nA: %s\nB: %s", settingsA, settingsB)
	}
}

func TestRunUpE_autoInitMissingMarkerFailsClosed(t *testing.T) {
	// init returns nil but leaves no settings marker (ConfirmFn deletes
	// cheasee-settings.json during the API-key phase and declines) → the
	// post-init re-resolution re-classifies the folder as non-initialized and
	// start fails closed naming the residue; no compose, no exec.
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
		deps.ConfirmFn = func(title string) (bool, error) {
			if strings.Contains(title, "Configure API keys") {
				_ = os.Remove(filepath.Join(wd, "cheasee-settings.json"))
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

	err := runUpE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "worktree/.bare residue") {
		t.Fatalf("expected fail-closed error naming the residue, got %v", err)
	}
	if !strings.Contains(err.Error(), "cheasee-pi start") {
		t.Errorf("refusal should point at re-running start in an empty folder, got %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("missing marker must never reach compose, got %d invocations: %v", len(c.composeArgs), c.composeArgs)
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
	// Residue cleaned: worktree + .bare removed, folder left empty.
	if _, statErr := os.Stat(workdir); !os.IsNotExist(statErr) {
		t.Errorf("failed auto-init must remove the worktree residue: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(parent, ".bare")); !os.IsNotExist(statErr) {
		t.Errorf("failed auto-init must remove .bare: %v", statErr)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("failed init must not reach compose, got %d invocations: %v", len(c.composeArgs), c.composeArgs)
	}
}

func TestRunUpE_autoInitContinuationDockerRecheck(t *testing.T) {
	// runInit's docker check (call 1) passes; the continuation's re-check
	// (call 2) fails → error surfaces post-init, no compose. The re-check is
	// a UX gate after a long OAuth stall, not a correctness requirement.
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	setUpRunMode(t, workdir, false)
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubInitGit(t)
	stubAutoInitDeps(t)
	stubExecPIContainer(t)

	var infoCalls int
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "info" {
			infoCalls++
			if infoCalls > 1 {
				return &mockCmd{runFn: func() error { return fmt.Errorf("Cannot connect to the Docker daemon") }}
			}
			return &mockCmd{}
		}
		if name == "docker" && len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("24.0.9"), nil }}
		}
		return saved(ctx, name, arg...)
	})
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	stubExecCommand(t, func(_ string, arg ...string) cmdIface {
		return &mockCmd{}
	})

	err := runUpE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("expected continuation docker-check failure, got %v", err)
	}
	if infoCalls != 2 {
		t.Errorf("docker check must run twice on the one-shot path (init + continuation), got %d", infoCalls)
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
	// the same one-shot path.
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
	if len(c.composeArgs) != 2 {
		t.Errorf(".DS_Store-only folder must take the one-shot path (build + up), got %d: %v", len(c.composeArgs), c.composeArgs)
	}
	if exec.name != containerName(workdir) {
		t.Errorf(".DS_Store-only one-shot must exec into %q, got %q", containerName(workdir), exec.name)
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
	// Regression: the one-shot confirmation is auto-init-only — an initialized
	// workspace start must not print it.
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
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "compose") {
			composeCalls++
			return &mockCmd{}
		}
		if name == "docker" && len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("24.0.9"), nil }}
		}
		return &mockCmd{}
	})
	stubExecCommand(t, func(_ string, arg ...string) cmdIface {
		if slices.Contains(arg, "ps") {
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
