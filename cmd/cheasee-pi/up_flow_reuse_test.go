package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
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
	if err == nil || !strings.Contains(err.Error(), "check container:") {
		t.Fatalf("state-probe failure must surface through runUpE, got %v", err)
	}
	if !strings.Contains(err.Error(), "docker ps:") {
		t.Errorf("error must carry the docker ps failure, got %v", err)
	}
	if composeCalls != 0 {
		t.Errorf("no compose around a failed probe, got %d", composeCalls)
	}
	if exec.name != "" {
		t.Errorf("exec must never run after a failed probe, got %q", exec.name)
	}
}

// ──────────────────────────────────────────────
// Phase 7: user journey — returning user
// ──────────────────────────────────────────────

func TestRunUpE_returningUserStoppedStackStartsInPlace(t *testing.T) {
	// Persona: returning user whose whole stack is stopped (docker compose
	// stop). Plain `cheasee-pi` starts the same containers — no build label,
	// no first-build notice, one exec.
	root, services := reusedStack(t)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)

	c := stubUpFlow(t, root, false)
	c.states = map[string]string{
		services[0].container: "exited",
		services[1].container: "exited",
		services[2].container: "exited",
	}

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})
	for _, unwanted := range []string{"Building container image...", "First start downloads"} {
		if strings.Contains(stderr, unwanted) {
			t.Errorf("returning user must not see %q, got: %q", unwanted, stderr)
		}
	}
	assertOrderedStderr(t, stderr, "CodeFlow", "inside pi:")
	if n := strings.Count(stderr, "inside pi:"); n != 1 {
		t.Errorf("cheatsheet must print exactly once, got %d in: %q", n, stderr)
	}
	wantStarts := []string{services[0].container, services[1].container, services[2].container}
	if !slices.Equal(c.starts, wantStarts) {
		t.Errorf("starts = %v, want %v", c.starts, wantStarts)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("stopped stack must not run compose, got %v", c.composeArgs)
	}
	if exec.name != containerName(root) || exec.target != "/workspaces/main" {
		t.Errorf("expected exactly one exec at -w /workspaces/main, got name=%q target=%q", exec.name, exec.target)
	}
}

func TestRunUpE_partialSetupCreatesMissingOnly(t *testing.T) {
	// Persona: the ui container was removed (`docker compose rm ui`), its
	// image is still there. Plain start creates only that container.
	root, services := reusedStack(t)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)

	c := stubUpFlow(t, root, false)
	c.states = map[string]string{
		services[0].container: "running",
		services[1].container: "running",
	}
	c.imageRefs = map[string]bool{services[2].image: true}

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})
	if strings.Contains(stderr, "Building container image...") {
		t.Errorf("present image must not build, got: %q", stderr)
	}
	if len(c.composeArgs) != 1 {
		t.Fatalf("exactly one create call expected, got %v", c.composeArgs)
	}
	got := c.composeArgs[0]
	for _, want := range []string{"up", "-d", "--remove-orphans", "--no-build", "--pull", "never", "ui"} {
		if !slices.Contains(got, want) {
			t.Errorf("create argv must carry %q, got %v", want, got)
		}
	}
	if exec.name != containerName(root) || exec.target != "/workspaces/main" {
		t.Errorf("expected exactly one exec at -w /workspaces/main, got name=%q target=%q", exec.name, exec.target)
	}
}

func TestRunUpE_startBuildStillRebuilds(t *testing.T) {
	root, services := reusedStack(t)
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)

	c := stubUpFlow(t, root, false)
	c.states = map[string]string{
		services[0].container: "running",
		services[1].container: "running",
		services[2].container: "running",
	}

	stderr := testutil.CaptureStderr(t, func() {
		upBuild = true
		defer func() { upBuild = false }()
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})
	if n := strings.Count(stderr, "Building container image..."); n != 1 {
		t.Errorf("--build must build exactly once, got %d in: %q", n, stderr)
	}
	if len(c.composeArgs) != 2 {
		t.Fatalf("--build must keep exactly build + up, got %v", c.composeArgs)
	}
	if !slices.Contains(c.composeArgs[0], "build") || !slices.Contains(c.composeArgs[1], "up") {
		t.Errorf("argv order must stay build then up, got %v", c.composeArgs)
	}
}

// ──────────────────────────────────────────────
// Phase 8: docs contract
// ──────────────────────────────────────────────

func TestCLIDoc_StartReuse(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "cli.md"))
	if err != nil {
		t.Fatalf("reading docs/cli.md: %v", err)
	}
	section, ok := markdownSection(string(data), "## `cheasee-pi` (no args) / `start`")
	if !ok {
		t.Fatal("docs/cli.md must keep the start section heading")
	}
	for _, want := range []string{"without rebuilding", "creates only missing", "builds only missing"} {
		if !strings.Contains(section, want) {
			t.Errorf("start docs must state %q, got:\n%s", want, section)
		}
	}
	if strings.Contains(section, "`docker compose up` if not running") {
		t.Errorf("start docs still describe the old compose-up-if-not-running flow:\n%s", section)
	}

	if strings.Contains(upCmd.Long, "starts it with docker compose up first") {
		t.Errorf("start --help still claims compose up if not running:\n%s", upCmd.Long)
	}
	if !strings.Contains(upCmd.Long, "--build") {
		t.Errorf("start --help must keep documenting --build:\n%s", upCmd.Long)
	}
}
