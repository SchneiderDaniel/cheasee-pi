package main

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// The start use case's flow-shape tests: what a run touches (and must not
// touch) for a given startOptions, driven without a cobra command.

func TestStartSession_dryRunTouchesNothing(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	c := stubUpFlow(t, root, false)
	rec := recordDockerSeams(t)

	stderr := testutil.CaptureStderr(t, func() {
		if err := startSession(context.Background(), startOptions{
			Workdir: root,
			DryRun:  true,
		}); err != nil {
			t.Fatalf("dry-run: %v", err)
		}
	})

	if len(c.composeArgs) != 0 {
		t.Errorf("dry-run must not invoke compose, got %v", c.composeArgs)
	}
	if c.imageGates != 0 {
		t.Errorf("dry-run must not run the image-presence gate, got %d", c.imageGates)
	}
	if exec.name != "" || exec.target != "" {
		t.Errorf("dry-run must not exec pi, got name=%q target=%q", exec.name, exec.target)
	}
	if calls := rec.callsContaining("compose"); len(calls) != 0 {
		t.Errorf("dry-run must reach no compose seam, got %v", calls)
	}
	if !strings.Contains(stderr, "Env vars to be injected") {
		t.Errorf("dry-run must print env vars, got %q", stderr)
	}
	if !strings.Contains(stderr, "Docker command") || !strings.Contains(stderr, "-w /workspaces/main") {
		t.Errorf("dry-run must print the docker command at -w /workspaces/main, got %q", stderr)
	}
}

func TestStartSession_dockerCheckFlag(t *testing.T) {
	for _, tc := range []struct {
		name     string
		noCheck  bool
		wantRuns int
	}{
		{"checked by default", false, 1},
		{"skipped with NoDockerCheck", true, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, root := mkWorkspace(t, `{}`)
			setUpRunMode(t, root, false)
			stubExecPIContainer(t)
			stubUpFlow(t, root, false)
			rec := recordDockerSeams(t)

			testutil.CaptureStderr(t, func() {
				if err := startSession(context.Background(), startOptions{
					Workdir:       root,
					NoDockerCheck: tc.noCheck,
					DryRun:        true,
				}); err != nil {
					t.Fatalf("startSession: %v", err)
				}
			})
			if got := rec.countVerb("version"); got != tc.wantRuns {
				t.Errorf("docker version probes = %d, want %d", got, tc.wantRuns)
			}
		})
	}
}

func TestStartSession_buildFlagSelectsTheComposePath(t *testing.T) {
	for _, tc := range []struct {
		name        string
		build       bool
		wantNoBuild bool
	}{
		{"reuse path without Build", false, true},
		{"rebuild path with Build", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, root := mkWorkspace(t, `{}`)
			setUpRunMode(t, root, false)
			stubExecPIContainer(t)
			c := stubUpFlow(t, root, false)

			testutil.CaptureStderr(t, func() {
				if err := startSession(context.Background(), startOptions{
					Workdir: root,
					Build:   tc.build,
				}); err != nil {
					t.Fatalf("startSession: %v", err)
				}
			})
			up := composeUp(c)
			if up == nil {
				t.Fatalf("no compose up invocation, got %v", c.composeArgs)
			}
			if got := slices.Contains(up, "--no-build"); got != tc.wantNoBuild {
				t.Errorf("compose up %v --no-build=%v, want %v", up, got, tc.wantNoBuild)
			}
		})
	}
}

func TestStartSession_ctxReachesTheDockerSeams(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)
	rec := recordDockerSeams(t)

	ctx := context.WithValue(context.Background(), ctxKey("test"), "marker")
	testutil.CaptureStderr(t, func() {
		if err := startSession(ctx, startOptions{Workdir: root}); err != nil {
			t.Fatalf("startSession: %v", err)
		}
	})

	if len(rec.ctxs) == 0 {
		t.Fatal("expected docker seam invocations")
	}
	for i, got := range rec.ctxs {
		if got.Value(ctxKey("test")) != "marker" {
			t.Errorf("docker call %d (%s) did not receive the caller's ctx", i, rec.calls[i])
		}
	}
	// The exec seam is the last thing a run does; it must carry the same ctx so
	// cancellation tears the interactive docker exec down.
	if exec.ctx == nil || exec.ctx.Value(ctxKey("test")) != "marker" {
		t.Error("the exec seam did not receive the caller's ctx")
	}
	if calls := rec.callsContaining("find", "/tmp"); len(calls) == 0 {
		t.Error("expected the container /tmp reclaim among the docker exec calls")
	}
}

func TestStartOptionsFromFlags_mapsTheCobraFlags(t *testing.T) {
	saved := [...]any{upName, upWorkdir, upBuild, upNoDockerCheck, upDryRun}
	t.Cleanup(func() {
		upName = saved[0].(string)
		upWorkdir = saved[1].(string)
		upBuild = saved[2].(bool)
		upNoDockerCheck = saved[3].(bool)
		upDryRun = saved[4].(bool)
	})
	upName, upWorkdir, upBuild, upNoDockerCheck, upDryRun = "custom", "/tmp/ws", true, true, true

	// An unset --name must not reach the use case: it has to derive.
	opts := startOptionsFromFlags(&cobra.Command{})
	want := startOptions{Workdir: "/tmp/ws", Build: true, NoDockerCheck: true, DryRun: true}
	if opts != want {
		t.Errorf("startOptionsFromFlags(no flags) = %+v, want %+v", opts, want)
	}

	cmd := &cobra.Command{}
	cmd.Flags().StringVar(&upName, "name", "", "container name override")
	if err := cmd.Flags().Set("name", "custom"); err != nil {
		t.Fatalf("set --name: %v", err)
	}
	if got := startOptionsFromFlags(cmd); got.Name != "custom" {
		t.Errorf("a changed --name must reach startOptions, got %q", got.Name)
	}
}
