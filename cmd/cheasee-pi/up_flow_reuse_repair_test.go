package main

import (
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

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
	for _, want := range []string{"up", "-d", "--no-build", "--pull", "never", "ui"} {
		if !slices.Contains(c.composeArgs[0], want) {
			t.Errorf("create argv must carry %q, got %v", want, c.composeArgs[0])
		}
	}
	if slices.Contains(c.composeArgs[0], "--remove-orphans") {
		t.Errorf("create must not remove existing containers, got %v", c.composeArgs[0])
	}
	if exec.name != containerName(root) || exec.target != "/workspaces/main" {
		t.Errorf("exec must target -w /workspaces/main, got name=%q target=%q", exec.name, exec.target)
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
