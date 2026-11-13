package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phases 4-5: stack executor (ensureStackUp)
// ──────────────────────────────────────────────

// stackFixture pins the hermetic workspace + seams an ensureStackUp test
// needs: derived identity from a real bare remote, a temp cache dir, and the
// docker/git seam from stubReadyFlow (states/imageRefs/starts captured).
func stackFixture(t *testing.T) (root, name, cacheDir string, c *upCapture) {
	t.Helper()
	return stackFixtureWith(t, func(context.Context, []string) runner { return &mockCmd{} })
}

// stackFixtureWith is stackFixture with a caller-supplied docker write-path
// stub (used to inject start/build/up failures).
func stackFixtureWith(t *testing.T, dockerFn func(context.Context, []string) runner) (root, name, cacheDir string, c *upCapture) {
	t.Helper()
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/foo.git")
	setUpReady(t)
	return root, containerName(root), t.TempDir(), stubReadyFlow(t, root, dockerFn)
}

// failingDocker makes dockerFn fail the calls the predicate matches.
func failingDocker(match func(arg []string) bool) func(context.Context, []string) runner {
	return func(_ context.Context, arg []string) runner {
		if !match(arg) {
			return &mockCmd{}
		}
		err := fmt.Errorf("docker %s failed", strings.Join(arg, " "))
		return &mockCmd{
			outputFn:   func() ([]byte, error) { return nil, err },
			combinedFn: func() ([]byte, error) { return nil, err },
			runFn:      func() error { return err },
		}
	}
}

func TestEnsureStackUp_allRunningTouchesNothing(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	c.states = map[string]string{
		services[0].container: "running",
		services[1].container: "running",
		services[2].container: "running",
	}
	c.imageRefs = map[string]bool{}

	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	if len(c.starts) != 0 {
		t.Errorf("running containers must not be started, got %v", c.starts)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("running stack must skip compose, got %v", c.composeArgs)
	}
	if len(c.imageProbes) != 0 {
		t.Errorf("running stack must not probe images, got %v", c.imageProbes)
	}
}

func TestEnsureStackUp_stoppedContainersStartWithoutCompose(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	c.states = map[string]string{
		services[0].container: "exited",
		services[1].container: "exited",
		services[2].container: "exited",
	}
	c.imageRefs = map[string]bool{}

	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	wantStarts := []string{services[0].container, services[1].container, services[2].container}
	if !slices.Equal(c.starts, wantStarts) {
		t.Errorf("starts = %v, want %v (stack order)", c.starts, wantStarts)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("starting existing containers must not touch compose, got %v", c.composeArgs)
	}
	if len(c.imageProbes) != 0 {
		t.Errorf("existing containers need no image probe, got %v", c.imageProbes)
	}
}

func TestEnsureStackUp_startFailureFailsFast(t *testing.T) {
	root, name, cacheDir, c := stackFixtureWith(t, failingDocker(func(arg []string) bool {
		return len(arg) > 1 && arg[0] == "start" && strings.Contains(arg[1], "codeflow")
	}))
	services := stackServices(root)
	c.states = map[string]string{
		services[0].container: "running",
		services[1].container: "exited",
		services[2].container: "exited",
	}
	c.imageRefs = map[string]bool{}
	codeflowContainer := services[1].container

	err := ensureStackUp(context.Background(), cacheDir, root, name)
	if err == nil || !strings.Contains(err.Error(), "start container "+codeflowContainer) {
		t.Fatalf("start failure must surface naming the container, got %v", err)
	}
	if len(c.starts) != 1 {
		t.Errorf("fail-fast: ui must not start after codeflow failed, got %v", c.starts)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("start failure must never fall back to compose, got %v", c.composeArgs)
	}
}

func TestEnsureStackUp_stateProbeFailureFailsClosed(t *testing.T) {
	root, name, cacheDir, c := stackFixtureWith(t, failingDocker(func(arg []string) bool {
		return slices.Contains(arg, "ps")
	}))

	err := ensureStackUp(context.Background(), cacheDir, root, name)
	if err == nil || !strings.Contains(err.Error(), "docker ps:") {
		t.Fatalf("probe failure must surface, got %v", err)
	}
	if len(c.starts) != 0 {
		t.Errorf("no start after a failed probe, got %v", c.starts)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("no compose after a failed probe, got %v", c.composeArgs)
	}
}
