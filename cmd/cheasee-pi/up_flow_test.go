package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// runUpE use-case tests (Phase 5 — repo mount restructure)
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
	stubExecCommand(t, func(_ string, arg ...string) cmdIface {
		if slices.Contains(arg, "ps") {
			names := ""
			if running {
				names = "cheasee-pi"
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(names), nil }}
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

func TestRunUpE_nonGitCwdRefusedNoDockerCalls(t *testing.T) {
	workdir := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(workdir, 0755); err != nil {
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
	if err == nil || !strings.Contains(err.Error(), "not a git repository") {
		t.Fatalf("expected git refusal, got %v", err)
	}
	if dockerCalls != 0 {
		t.Errorf("non-git cwd must be refused before any docker invocation, got %d", dockerCalls)
	}
}

func TestRunUpE_dryRunPrintsWithoutScaffoldOrCompose(t *testing.T) {
	root := t.TempDir()
	setUpRun(t, root)

	c := stubUpFlow(t, root, false)
	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	// Dry-run touches nothing: no scaffold, no compose, no extraction.
	if _, err := os.Stat(filepath.Join(root, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Errorf("dry-run must not scaffold .pi/settings.json: %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("dry-run must not invoke compose, got %d invocations: %v", len(c.composeArgs), c.composeArgs)
	}

	// Prints the env vars and the docker exec command it would run.
	if !strings.Contains(stderr, "Env vars to be injected") {
		t.Errorf("dry-run must print env vars, got: %q", stderr)
	}
	if !strings.Contains(stderr, "Docker command") || !strings.Contains(stderr, "-w /workspaces/main") {
		t.Errorf("dry-run must print the docker command at -w /workspaces/main, got: %q", stderr)
	}
}

func TestRunUpE_fullFlowScaffoldsThenComposeUp(t *testing.T) {
	root := t.TempDir()
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)

	c := stubUpFlow(t, root, false)
	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	// Scaffold: absolute /opt/cheasee-pi paths written into the repo root.
	data, err := os.ReadFile(filepath.Join(root, ".pi", "settings.json"))
	if err != nil {
		t.Fatalf("settings scaffold missing: %v", err)
	}
	if !strings.Contains(string(data), "/opt/cheasee-pi/.pi/skills") {
		t.Errorf("scaffold must use absolute /opt/cheasee-pi paths:\n%s", data)
	}
	if !strings.Contains(stderr, "Created .pi/settings.json") {
		t.Errorf("user should see a scaffold notice, got: %q", stderr)
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
	if !slices.Contains(build, "build") || !strings.Contains(strings.Join(build, " "), "PI_BUILD_STAMP=") {
		t.Errorf("build must pass PI_BUILD_STAMP, got %v", build)
	}
	if !slices.Contains(up, "up") || !slices.Contains(up, "--remove-orphans") {
		t.Errorf("up args wrong: %v", up)
	}

	// WORKSPACE_HOST_PATH = CLI-resolved absolute toplevel; ${PWD} never used.
	upEnv := c.composeCmds[1].env
	if !slices.Contains(upEnv, "WORKSPACE_HOST_PATH="+root) {
		t.Errorf("up env must carry WORKSPACE_HOST_PATH=%s, got %v", root, upEnv)
	}
	for _, e := range upEnv {
		if strings.Contains(e, "${PWD}") || strings.HasPrefix(e, "WORKSPACE_HOST_PATH=${PWD}") {
			t.Errorf("WORKSPACE_HOST_PATH must never use ${PWD}: %v", upEnv)
		}
	}
	// Memory + git identity from the scaffolded settings.
	if !slices.Contains(upEnv, "CHEASEEPI_MEMORY=2G") {
		t.Errorf("up env must carry CHEASEEPI_MEMORY from settings, got %v", upEnv)
	}
	if !slices.Contains(upEnv, "HOST_GIT_NAME=Test User") {
		t.Errorf("up env must carry HOST_GIT_NAME from settings gitIdentity, got %v", upEnv)
	}

	// Final exec descends to the toplevel target.
	if exec.name != "cheasee-pi" || exec.target != "/workspaces/main" {
		t.Errorf("exec must target -w /workspaces/main in container %q, got name=%q target=%q", "cheasee-pi", exec.name, exec.target)
	}
}

func TestRunUpE_existingSettingsUntouched(t *testing.T) {
	root := t.TempDir()
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)

	legacy := `{"defaultProvider": "openai", "skills": ["../private-pi/skills"], "docker": {"memory": ""}}`
	if err := os.MkdirAll(filepath.Join(root, ".pi"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".pi", "settings.json"), []byte(legacy), 0644); err != nil {
		t.Fatal(err)
	}

	c := stubUpFlow(t, root, false)
	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}

	// Never-overwrite rule: byte-identical after start.
	after, err := os.ReadFile(filepath.Join(root, ".pi", "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != legacy {
		t.Errorf("existing settings.json must be byte-preserved:\n got %q\nwant %q", after, legacy)
	}
	// Legacy settings load fine (no memory limit → no CHEASEEPI_MEMORY env).
	upEnv := c.composeCmds[1].env
	for _, e := range upEnv {
		if strings.HasPrefix(e, "CHEASEEPI_MEMORY=") {
			t.Errorf("no memory limit configured → no CHEASEEPI_MEMORY, got %v", upEnv)
		}
	}
}

func TestRunUpE_subdirExecTarget(t *testing.T) {
	root := t.TempDir()
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

	// Dry-run prints the toplevel-mounted exec target with the relative cwd.
	if !strings.Contains(stderr, "-w /workspaces/main/sub/dir") {
		t.Errorf("dry-run must exec at -w /workspaces/main/sub/dir, got: %q", stderr)
	}
	// Dry-run touches nothing: no scaffold at the repo root, no compose.
	if _, err := os.Stat(filepath.Join(root, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Errorf("dry-run must not scaffold settings, got: %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("dry-run must not invoke compose, got %d: %v", len(c.composeArgs), c.composeArgs)
	}
}

func TestRunUpE_subdirFullFlowMountsToplevel(t *testing.T) {
	root := t.TempDir()
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
	// Settings scaffold lives once at the repo root.
	if _, err := os.Stat(filepath.Join(root, ".pi", "settings.json")); err != nil {
		t.Errorf("settings must be scaffolded at the repo root: %v", err)
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
	root := t.TempDir()
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
	if exec.name != "cheasee-pi" {
		t.Errorf("exec must still run against the running container, got name=%q", exec.name)
	}
}

func TestRunUpE_selinuxRelabelToggle(t *testing.T) {
	root := t.TempDir()
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
