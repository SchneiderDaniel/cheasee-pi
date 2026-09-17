package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// Shared fixtures for the up command test split. Single home for the
// cross-file helpers used by up_flow, up_env, up_orphans, up_workspace
// and the untouched up_* test files; moved verbatim from the old
// up_flow_test.go.
// ──────────────────────────────────────────────

// upFlowImageState drives the stubs' `docker image inspect` branch — the
// first-build gate. Distinct from the health-wait inspect (which always
// answers "healthy"): without a distinct branch, the old "healthy" catch-all
// would swallow the gate and silently suppress the notice in every test.
// Zero value = missing, so existing call sites exercise the notice path.
type upFlowImageState int

const (
	upImageMissing     upFlowImageState = iota // docker image inspect exits 1 → first build → notice
	upImagePresent                             // exits 0 → image cached → no notice
	upImageDaemonError                         // any non-1 exit → fail-closed error
)

type upCapture struct {
	composeArgs [][]string
	composeCmds []*mockCmd
	imageGates  int // docker image inspect gate calls (first-build check)
	imageState  upFlowImageState
}

// stubImageGate returns the runner for the first-build `docker image inspect`
// gate per the capture's imageState, counting the call so tests can assert
// the gate only runs when a build will run.
func (c *upCapture) stubImageGate() runner {
	c.imageGates++
	switch c.imageState {
	case upImagePresent:
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("[]"), nil }}
	case upImageDaemonError:
		return &mockCmd{outputFn: func() ([]byte, error) { return nil, exitStatusError(2) }}
	default: // upImageMissing
		return &mockCmd{outputFn: func() ([]byte, error) { return nil, exitStatusError(1) }}
	}
}

// stubUpFlow stubs the docker+git seams for runUpE use-case tests: git
// resolves to root (relCwd derived from the physical workdir), docker ps
// reports the container running state, compose invocations are captured.
func stubUpFlow(t *testing.T, root string, running bool) *upCapture {
	t.Helper()
	c := &upCapture{}
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	saved := runCommandContext
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
			if slices.Contains(arg, "config") {
				// Real .bare config read for identity derivation (fixture remotes).
				return saved(ctx, name, arg...)
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
		if name == "docker" && slices.Contains(arg, "ps") {
			names := ""
			if running {
				names = containerName(root)
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(names), nil }}
		}
		if name == "docker" && slices.Contains(arg, "image") && slices.Contains(arg, "inspect") {
			// First-build gate — distinct from the health-wait inspect below.
			return c.stubImageGate()
		}
		if name == "docker" && slices.Contains(arg, "inspect") {
			// Ready-marker healthcheck: entrypoint setup assumed complete. On
			// the running&&!build path the drift check calls the same inspect
			// seam with `--format {{json .}}` — answer a matching sidecar
			// (label-less old-container form: mount matches the current cache
			// dir, no explicit port) so existing tests stay warning-free.
			if slices.Contains(arg, "{{json .}}") {
				cacheDir, _ := CacheDir()
				return codeflowInspectRunner(mustJSON(codeflowInspectDoc(cacheDir, "", "")))
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		return &mockCmd{} // docker info
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
	// Hermetic CodeFlow port: a host CODEFLOW_PORT must not leak into the
	// derived-case assertions (the env-override cases set it explicitly).
	t.Setenv("CODEFLOW_PORT", "")
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

// stubAutoInitDeps replaces the shared newInitDeps factory so the empty-
// folder auto-init path runs with the stubbed OAuth/prompt boundaries (the
// same seam runInitE tests use) instead of a real device flow or TTY.
func stubAutoInitDeps(t *testing.T) {
	t.Helper()
	saved := newInitDeps
	newInitDeps = func(workdir string) InitDeps {
		return initDepsWithRepoURL(t, workdir)
	}
	t.Cleanup(func() { newInitDeps = saved })
}
