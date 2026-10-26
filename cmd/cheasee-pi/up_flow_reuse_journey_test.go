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

func TestRunUpE_returningUserStoppedStackStartsInPlace(t *testing.T) {
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
	for _, want := range []string{"up", "-d", "--no-build", "--pull", "never", "ui"} {
		if !slices.Contains(got, want) {
			t.Errorf("create argv must carry %q, got %v", want, got)
		}
	}
	if slices.Contains(got, "--remove-orphans") {
		t.Errorf("create argv must not remove orphans (existing containers stay), got %v", got)
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
