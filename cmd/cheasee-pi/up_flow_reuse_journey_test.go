package main

import (
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

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
