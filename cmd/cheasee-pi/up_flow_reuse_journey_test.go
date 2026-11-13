package main

import (
	"context"
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
	if err == nil || !strings.Contains(err.Error(), "check container:") || !strings.Contains(err.Error(), "docker ps:") {
		t.Fatalf("state-probe error must surface, got %v", err)
	}
	if composeCalls != 0 || exec.name != "" {
		t.Errorf("failed probe must skip compose and exec; compose=%d exec=%q", composeCalls, exec.name)
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
