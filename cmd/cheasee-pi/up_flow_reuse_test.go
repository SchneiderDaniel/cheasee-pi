package main

import (
	"context"
	"slices"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 6: orchestrator contract (ensureContainerReady / runUpE)
// ──────────────────────────────────────────────

// argHas reports whether any argv element contains needle.
func argHas(arg []string, needle string) bool {
	return strings.Contains(strings.Join(arg, " "), needle)
}

// reusedStack pins the derived identity for the orchestration-level tests.
func reusedStack(t *testing.T) (root string, services []stackService) {
	t.Helper()
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/foo.git")
	return root, stackServices(root)
}

func TestEnsureContainerReady_runningStackNoComposeNoStart(t *testing.T) {
	root, services := reusedStack(t)
	setUpReady(t)
	name := containerName(root)

	var healthPolls int
	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "inspect") {
			if slices.Contains(arg, "{{json .}}") {
				cacheDir, _ := CacheDir()
				return codeflowInspectRunner(mustJSON(codeflowInspectDoc(cacheDir, "", "")))
			}
			healthPolls++
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		return &mockCmd{}
	})
	c.states = map[string]string{
		services[0].container: "running",
		services[1].container: "running",
		services[2].container: "running",
	}

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
	if len(c.composeArgs) != 0 {
		t.Errorf("running stack must skip compose, got %d", len(c.composeArgs))
	}
	if len(c.starts) != 0 {
		t.Errorf("running stack must not docker start, got %v", c.starts)
	}
	if len(c.imageProbes) != 0 {
		t.Errorf("running stack must not probe images, got %v", c.imageProbes)
	}
	if healthPolls != 1 {
		t.Errorf("expected exactly 1 health poll, got %d", healthPolls)
	}
}

func TestEnsureContainerReady_stoppedStackStartsWithoutCompose(t *testing.T) {
	root, services := reusedStack(t)
	setUpReady(t)
	name := containerName(root)

	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "inspect") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		return &mockCmd{}
	})
	c.states = map[string]string{
		services[0].container: "exited",
		services[1].container: "exited",
		services[2].container: "exited",
	}

	if _, err := ensureContainerReady(context.Background(), root, name, false); err != nil {
		t.Fatalf("ensureContainerReady: %v", err)
	}
	wantStarts := []string{services[0].container, services[1].container, services[2].container}
	if !slices.Equal(c.starts, wantStarts) {
		t.Errorf("starts = %v, want %v", c.starts, wantStarts)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("stopped stack must start, not rebuild, got compose %v", c.composeArgs)
	}
}

func TestEnsureContainerReady_buildFlagKeepsRebuildContract(t *testing.T) {
	root, _ := reusedStack(t)
	setUpReady(t)

	c := stubReadyFlow(t, root, readyFlowDockerFn(root, false))
	c.imageState = upImagePresent
	if _, err := ensureContainerReady(context.Background(), root, containerName(root), true); err != nil {
		t.Fatalf("ensureContainerReady: %v", err)
	}
	if len(c.composeArgs) != 2 {
		t.Fatalf("--build must keep exactly build + up, got %v", c.composeArgs)
	}
	build, up := c.composeArgs[0], c.composeArgs[1]
	for _, unwanted := range []string{"--no-build", "--pull", "cheasee-pi", "codeflow", "ui"} {
		if slices.Contains(build, unwanted) {
			t.Errorf("--build must stay an all-services build without %q, got %v", unwanted, build)
		}
	}
	for _, unwanted := range []string{"--no-build", "--pull", "never"} {
		if slices.Contains(up, unwanted) {
			t.Errorf("--build up must not carry %q, got %v", unwanted, up)
		}
	}
	if !slices.Contains(up, "--remove-orphans") {
		t.Errorf("--build up must keep --remove-orphans, got %v", up)
	}
}

func TestEnsureContainerReady_stateProbeErrorSurfacesOnce(t *testing.T) {
	root, _ := reusedStack(t)
	setUpReady(t)

	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "git" {
			return &mockCmd{}
		}
		if argHas(arg, "{{.State}}") {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, exitStatusError(2) }}
		}
		return &mockCmd{}
	})

	_, err := ensureContainerReady(context.Background(), root, containerName(root), false)
	if err == nil {
		t.Fatal("probe failure must surface")
	}
	if n := strings.Count(err.Error(), "check container:"); n != 1 {
		t.Errorf("error must carry 'check container:' exactly once, got %d in %q", n, err)
	}
	if !strings.Contains(err.Error(), "docker ps:") {
		t.Errorf("error must carry the docker ps failure, got %q", err)
	}
}

func TestEnsureContainerReady_startFailureNoComposeFallback(t *testing.T) {
	root, services := reusedStack(t)
	setUpReady(t)

	c := stubReadyFlow(t, root, failingDocker(func(arg []string) bool {
		return len(arg) > 1 && arg[0] == "start"
	}))
	c.states = map[string]string{
		services[0].container: "exited",
		services[1].container: "exited",
		services[2].container: "exited",
	}

	_, err := ensureContainerReady(context.Background(), root, containerName(root), false)
	if err == nil {
		t.Fatal("start failure must surface")
	}
	if strings.Contains(err.Error(), "docker compose up:") {
		t.Errorf("start failure must not be wrapped as a compose fallback, got %q", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("start failure must never fall back to compose, got %v", c.composeArgs)
	}
}

// ──────────────────────────────────────────────
// Phase 7: user journey — returning user
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// Phase 8: docs contract
// ──────────────────────────────────────────────
