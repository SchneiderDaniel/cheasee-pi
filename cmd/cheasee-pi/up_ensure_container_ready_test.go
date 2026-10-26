package main

import (
	"context"
	"path/filepath"
	"slices"
	"testing"
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
	// Ample free space: the build inside dockerComposeUp now runs the disk
	// gate (docker info --format below). Tests that count docker calls would
	// otherwise see the gate's probe through the dockerFn catch-all.
	stubStatfsAmple(t)
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	saved := runCommandContext
	git := gitRootMock(root, saved)
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "git" {
			return git(ctx, name, arg...)
		}
		if name == "docker" && slices.Contains(arg, "{{.DockerRootDir}}") {
			// Disk gate probe — answered here, not routed to dockerFn, so the
			// per-test docker call counts stay stable.
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("/var/lib/docker\n"), nil }}
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
		if name == "docker" && slices.Contains(arg, "ps") && c.states != nil {
			// Explicit per-container states (ensureStackUp tests): answered here
			// so the caller's dockerFn stays the write-path stub.
			return &mockCmd{outputFn: func() ([]byte, error) { return c.psOutput(root, false, arg), nil }}
		}
		if name == "docker" && len(arg) > 1 && arg[0] == "start" {
			c.starts = append(c.starts, arg[1])
			return dockerFn(ctx, arg)
		}
		if name == "docker" && slices.Contains(arg, "image") && slices.Contains(arg, "inspect") {
			// First-build / create probe — intercepted before dockerFn so the
			// per-test health-wait inspect catch-all can't swallow it (default
			// missing, flip c.imageState for anti-nag / fail-closed tests).
			return c.stubImageGate(arg[len(arg)-1])
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
	if !slices.Contains(c.composeArgs[1], "up") || !slices.Contains(c.composeArgs[1], "--no-build") || !slices.Contains(c.composeArgs[1], "--pull") {
		t.Errorf("second compose call must create only missing containers (up -d --no-build --pull never), got %v", c.composeArgs[1])
	}
	if slices.Contains(c.composeArgs[1], "--remove-orphans") {
		t.Errorf("create path must not remove orphans, got %v", c.composeArgs[1])
	}
	upEnv := c.composeCmds[1].env
	if !slices.Contains(upEnv, "WORKSPACE_HOST_PATH="+root) {
		t.Errorf("up env must carry WORKSPACE_HOST_PATH=%s, got %v", root, upEnv)
	}
	if inspectCalls != 1 {
		t.Errorf("expected exactly 1 health poll, got %d", inspectCalls)
	}
	if dockerCalls != 5 { // containerRunning ps + state probe + compose build + compose up + inspect
		t.Errorf("unexpected docker call count %d (want 2×ps+2×compose+inspect)", dockerCalls)
	}
}
