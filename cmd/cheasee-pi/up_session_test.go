package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// startSession is the start use case. These tests drive it with a literal
// startOptions (no cobra command); the flag-mapping and runUpE adapter tests
// live in up_session_flow_test.go and up_session_adapter_test.go, which share
// the docker seam recorder below.
// ──────────────────────────────────────────────

// dockerSeamRecord collects every docker invocation (joined argv) and the ctx
// it carried, layered on top of the stub stubUpFlow installed.
type dockerSeamRecord struct {
	calls []string
	ctxs  []context.Context
}

// recordDockerSeams wraps the currently installed runCommandContext seam so a
// test can observe the docker calls and their ctx without replacing the flow
// stub.
func recordDockerSeams(t *testing.T) *dockerSeamRecord {
	t.Helper()
	rec := &dockerSeamRecord{}
	inner := runCommandContext
	runCommandContext = func(ctx context.Context, name string, arg ...string) runner {
		if name == "docker" {
			rec.calls = append(rec.calls, strings.Join(arg, " "))
			rec.ctxs = append(rec.ctxs, ctx)
		}
		return inner(ctx, name, arg...)
	}
	t.Cleanup(func() { runCommandContext = inner })
	return rec
}

// countVerb counts the docker invocations whose first argument is verb.
func (r *dockerSeamRecord) countVerb(verb string) int {
	n := 0
	for _, call := range r.calls {
		if call == verb || strings.HasPrefix(call, verb+" ") {
			n++
		}
	}
	return n
}

// callsContaining returns the recorded invocations containing every part.
func (r *dockerSeamRecord) callsContaining(parts ...string) []string {
	var hits []string
	for _, call := range r.calls {
		matched := true
		for _, part := range parts {
			if !strings.Contains(call, part) {
				matched = false
				break
			}
		}
		if matched {
			hits = append(hits, call)
		}
	}
	return hits
}

// composeUp returns the compose `up` argv, nil when compose never ran `up`.
func composeUp(c *upCapture) []string {
	for _, args := range c.composeArgs {
		if slices.Contains(args, "up") {
			return args
		}
	}
	return nil
}

func TestStartSession_runsTheFullFlowWithoutCobra(t *testing.T) {
	_, root := mkWorkspace(t, `{"docker": {"memory": "2G", "cpus": "2.0"}}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	c := stubUpFlow(t, root, false)

	stderr := testutil.CaptureStderr(t, func() {
		if err := startSession(context.Background(), startOptions{
			Name:    "explicit-container",
			Workdir: root,
		}); err != nil {
			t.Fatalf("startSession: %v", err)
		}
	})

	if exec.name != "explicit-container" {
		t.Errorf("exec name = %q, want startOptions.Name verbatim", exec.name)
	}
	if exec.target != "/workspaces/main" {
		t.Errorf("exec target = %q, want /workspaces/main at the workspace root", exec.target)
	}
	for _, key := range []string{"CODEFLOW_PORT", "CHEASEE_SESSION_ID", "PI_UI_PORT"} {
		if exec.env[key] == "" {
			t.Errorf("exec env must carry %s, got %v", key, exec.env)
		}
	}
	if len(composeUp(c)) == 0 {
		t.Errorf("the run must bring the stack up, got %v", c.composeArgs)
	}
	if !strings.Contains(stderr, "inside pi:") {
		t.Errorf("the run must print the launch cheatsheet, got %q", stderr)
	}
	claimDir := filepath.Join(root, ".pi", "sessions", ".cheasee-inuse")
	if entries, err := os.ReadDir(claimDir); err == nil && len(entries) != 0 {
		t.Errorf("the live-session claim must be released after the run, found %v", entries)
	}
}

func TestStartSession_derivesTheContainerName(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)

	testutil.CaptureStderr(t, func() {
		if err := startSession(context.Background(), startOptions{Workdir: root}); err != nil {
			t.Fatalf("startSession: %v", err)
		}
	})
	if exec.name != containerName(root) {
		t.Errorf("exec name = %q, want the derived %q", exec.name, containerName(root))
	}
}
