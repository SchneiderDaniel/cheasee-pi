package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"
)

// ──────────────────────────────────────────────
// ensureContainerReady direct unit tests
// ──────────────────────────────────────────────

// stubReadyFlow stubs the docker+git seams for the ensureContainerReady /
// runUpE container-ready tests: git worktree resolution and the docker
// version check succeed; compose invocations are captured (run/env observed
// via c.composeCmds); every other docker call (ps, inspect, info) dispatches
// to dockerFn with the caller's ctx.
func stubReadyFlow(t *testing.T, root string, dockerFn func(ctx context.Context, arg []string) runner) *upCapture {
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
		if name == "docker" && len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("24.0.9"), nil }}
		}
		if name == "docker" && slices.Contains(arg, "compose") {
			m := dockerFn(ctx, arg).(*mockCmd)
			c.composeArgs = append(c.composeArgs, arg)
			c.composeCmds = append(c.composeCmds, m)
			return m
		}
		return dockerFn(ctx, arg)
	})
	return c
}

// setUpReady pins the hermetic homes a direct ensureContainerReady test needs:
// fresh XDG_CACHE_HOME (the version-keyed cache dir resolves under it) and a
// cleared CODEFLOW_PORT so a host value can't leak into the compose env.
func setUpReady(t *testing.T) {
	t.Helper()
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("CODEFLOW_PORT", "")
}

func TestEnsureContainerReady_notRunningStartsAndWaits(t *testing.T) {
	// Not-running container, no --build: compose build+up from the
	// version-keyed cache dir, env carries the CLI-resolved workspace path,
	// then exactly one health poll; cacheDir returned == CacheDir() (the
	// compose -f dir).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)

	var dockerCalls, inspectCalls int
	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		dockerCalls++
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		if slices.Contains(arg, "inspect") {
			inspectCalls++
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		return &mockCmd{}
	})

	cacheDir, err := ensureContainerReady(context.Background(), root, name, false)
	if err != nil {
		t.Fatalf("ensureContainerReady: %v", err)
	}
	wantCache, err := CacheDir()
	if err != nil {
		t.Fatal(err)
	}
	if cacheDir != wantCache {
		t.Errorf("cacheDir = %q, want %q", cacheDir, wantCache)
	}

	// Exactly two compose invocations (build then up), both -f'ing the
	// version-keyed compose file.
	if len(c.composeArgs) != 2 {
		t.Fatalf("expected build + up compose calls, got %d: %v", len(c.composeArgs), c.composeArgs)
	}
	composeFile := filepath.Join(wantCache, "docker-compose.yml")
	for i, args := range c.composeArgs {
		if !slices.Contains(args, "-f") || !slices.Contains(args, composeFile) {
			t.Errorf("compose call %d must target %s, got %v", i, composeFile, args)
		}
	}
	if !slices.Contains(c.composeArgs[0], "build") {
		t.Errorf("first compose call must build, got %v", c.composeArgs[0])
	}
	if !slices.Contains(c.composeArgs[1], "up") || !slices.Contains(c.composeArgs[1], "--remove-orphans") {
		t.Errorf("second compose call must up -d --remove-orphans, got %v", c.composeArgs[1])
	}
	upEnv := c.composeCmds[1].env
	if !slices.Contains(upEnv, "WORKSPACE_HOST_PATH="+root) {
		t.Errorf("up env must carry WORKSPACE_HOST_PATH=%s, got %v", root, upEnv)
	}
	if inspectCalls != 1 {
		t.Errorf("expected exactly 1 health poll, got %d", inspectCalls)
	}
	if dockerCalls != 4 { // ps + compose build + compose up + inspect
		t.Errorf("unexpected docker call count %d (want ps+2×compose+inspect)", dockerCalls)
	}
}

func TestEnsureContainerReady_alreadyRunningSkipsCompose(t *testing.T) {
	// Running container, no --build: compose is skipped BUT the ready-wait
	// still polls once (the path compose-native --wait can't cover).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)

	var inspectCalls int
	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(name), nil }}
		}
		if slices.Contains(arg, "inspect") {
			inspectCalls++
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		return &mockCmd{}
	})

	cacheDir, err := ensureContainerReady(context.Background(), root, name, false)
	if err != nil {
		t.Fatalf("ensureContainerReady: %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("running container must skip compose, got %d calls: %v", len(c.composeArgs), c.composeArgs)
	}
	if inspectCalls != 1 {
		t.Errorf("skipping compose must NOT skip the ready-wait, got %d health polls", inspectCalls)
	}
	wantCache, _ := CacheDir()
	if cacheDir != wantCache {
		t.Errorf("cacheDir = %q, want %q", cacheDir, wantCache)
	}
}

func TestEnsureContainerReady_runningWithBuildForcesCompose(t *testing.T) {
	// Running + --build: compose build+up still invoked (build forces recreate).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)

	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(name), nil }}
		}
		if slices.Contains(arg, "inspect") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		return &mockCmd{}
	})

	if _, err := ensureContainerReady(context.Background(), root, name, true); err != nil {
		t.Fatalf("ensureContainerReady: %v", err)
	}
	if len(c.composeArgs) != 2 {
		t.Errorf("--build must force recreate (build + up) even when running, got %d calls: %v", len(c.composeArgs), c.composeArgs)
	}
}

func TestEnsureContainerReady_psFailsWrapsCheckContainer(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)

	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon gone") }}
		}
		return &mockCmd{}
	})

	_, err := ensureContainerReady(context.Background(), root, containerName(root), false)
	if err == nil || !strings.Contains(err.Error(), "check container:") {
		t.Fatalf("ps failure must wrap as 'check container: ...', got %v", err)
	}
	if !strings.Contains(err.Error(), "docker ps:") {
		t.Errorf("error must carry the underlying docker ps failure, got %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("no compose may run when the container check fails, got %d calls", len(c.composeArgs))
	}
}

func TestEnsureContainerReady_composeFailsWraps(t *testing.T) {
	// Compose build fails → 'docker compose up:' wrap; waitHealthy unreached.
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)

	var inspectCalls int
	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		if slices.Contains(arg, "inspect") {
			inspectCalls++
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		if slices.Contains(arg, "compose") {
			return &mockCmd{runFn: func() error { return fmt.Errorf("compose exploded") }}
		}
		return &mockCmd{}
	})

	_, err := ensureContainerReady(context.Background(), root, containerName(root), false)
	if err == nil || !strings.Contains(err.Error(), "docker compose up:") {
		t.Fatalf("compose failure must wrap as 'docker compose up: ...', got %v", err)
	}
	if len(c.composeArgs) != 1 {
		t.Errorf("compose build failure must stop before the up call, got %d calls: %v", len(c.composeArgs), c.composeArgs)
	}
	if inspectCalls != 0 {
		t.Errorf("waitHealthy must be unreached when compose fails, got %d health polls", inspectCalls)
	}
}

func TestEnsureContainerReady_extractFailsWraps(t *testing.T) {
	// Pre-create <cacheDir>/lib as a regular file: the extractor's MkdirAll
	// for the lib/ dir hits ENOTDIR (root-safe, no chmod) → 'extract compose
	// files:' wrap and 0 docker calls (extract precedes any docker work).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir, err := CacheDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "lib"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	var dockerCalls int
	c := stubReadyFlow(t, root, func(_ context.Context, _ []string) runner {
		dockerCalls++
		return &mockCmd{}
	})

	_, err = ensureContainerReady(context.Background(), root, containerName(root), false)
	if err == nil || !strings.Contains(err.Error(), "extract compose files:") {
		t.Fatalf("extract failure must wrap as 'extract compose files: ...', got %v", err)
	}
	if dockerCalls != 0 {
		t.Errorf("extract must precede any docker call, got %d", dockerCalls)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("no compose may run when extract fails, got %d calls", len(c.composeArgs))
	}
}

func TestEnsureContainerReady_preCancelledCtxFailsFast(t *testing.T) {
	// Pre-cancelled ctx fails at the cache-dir gate before any docker work —
	// the helper-level analog of the dry-run-touches-nothing invariant.
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)

	var dockerCalls int
	stubReadyFlow(t, root, func(_ context.Context, _ []string) runner {
		dockerCalls++
		return &mockCmd{}
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := ensureContainerReady(ctx, root, "nope", false)
	if err == nil || !strings.Contains(err.Error(), "cache dir: context canceled") {
		t.Fatalf("pre-cancelled ctx must fail at the cache-dir gate, got %v", err)
	}
	if dockerCalls != 0 {
		t.Errorf("pre-cancelled ctx must not reach docker, got %d calls", dockerCalls)
	}
}

func TestEnsureContainerReady_notHealthyTimesOut(t *testing.T) {
	// Not healthy past the timeout → waitHealthy's raw message surfaces with
	// NO helper wrap prefix (the diff returns it unwrapped).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)

	saved := healthWaitTimeout
	healthWaitTimeout = time.Nanosecond
	t.Cleanup(func() { healthWaitTimeout = saved })

	name := containerName(root)
	stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		if slices.Contains(arg, "inspect") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("starting"), nil }}
		}
		return &mockCmd{}
	})

	_, err := ensureContainerReady(context.Background(), root, name, false)
	if err == nil {
		t.Fatal("expected the health-wait timeout error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "not healthy after") || !strings.Contains(msg, "docker logs") {
		t.Errorf("error must be waitHealthy's raw message, got %q", msg)
	}
	if !strings.Contains(msg, name) {
		t.Errorf("error must name the container, got %q", msg)
	}
	for _, prefix := range []string{"cache dir:", "extract compose files:", "check container:", "docker compose up:"} {
		if strings.Contains(msg, prefix) {
			t.Errorf("timeout error must not carry the %q wrap prefix, got %q", prefix, msg)
		}
	}
}

func TestEnsureContainerReady_ctxForwardedToSeams(t *testing.T) {
	// Marker-value ctx must reach the docker ps AND docker inspect seam calls
	// unchanged — guards the issue snippet's containerRunning(name) trap
	// (the real signature is containerRunning(ctx, name)).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)

	ctx := context.WithValue(context.Background(), ctxKey("marker"), "v")
	var seen []context.Context
	stubReadyFlow(t, root, func(got context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") || slices.Contains(arg, "inspect") {
			seen = append(seen, got)
		}
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		if slices.Contains(arg, "inspect") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		return &mockCmd{}
	})

	if _, err := ensureContainerReady(ctx, root, name, false); err != nil {
		t.Fatalf("ensureContainerReady: %v", err)
	}
	if len(seen) != 2 {
		t.Fatalf("expected ps + inspect seam calls, got %d", len(seen))
	}
	for i, got := range seen {
		if got.Value(ctxKey("marker")) != "v" {
			t.Errorf("seam call %d did not receive the caller's ctx", i)
		}
	}
}

// ──────────────────────────────────────────────
// runUpE orchestrator regression (new use cases)
// ──────────────────────────────────────────────

func TestRunUpE_containerCheckErrorPropagatesUnwrapped(t *testing.T) {
	// docker ps fails via seam → runUpE returns the helper error verbatim
	// ('check container:' exactly once — no double-wrap, per the diff).
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)

	stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon gone") }}
		}
		return &mockCmd{}
	})

	err := runUpE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "check container:") {
		t.Fatalf("ps failure must surface through runUpE, got %v", err)
	}
	if strings.Count(err.Error(), "check container:") != 1 {
		t.Errorf("helper error must not be double-wrapped, got %q", err)
	}
	if !strings.Contains(err.Error(), "docker ps:") {
		t.Errorf("error must carry the underlying docker ps failure, got %q", err)
	}
}

func TestRunUpE_waitHealthyTimeoutSurfaces(t *testing.T) {
	// healthWaitTimeout→1ns + inspect→'starting' → the waitHealthy timeout
	// surfaces unchanged through runUpE.
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)

	saved := healthWaitTimeout
	healthWaitTimeout = time.Nanosecond
	t.Cleanup(func() { healthWaitTimeout = saved })

	stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		if slices.Contains(arg, "inspect") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("starting"), nil }}
		}
		return &mockCmd{}
	})

	err := runUpE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "not healthy after") {
		t.Fatalf("health-wait timeout must surface through runUpE, got %v", err)
	}
	if !strings.Contains(err.Error(), "docker logs") {
		t.Errorf("error must carry the docker logs hint, got %q", err)
	}
}
