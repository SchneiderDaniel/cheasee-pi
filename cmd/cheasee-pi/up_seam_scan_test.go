package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// scanOrphans ctx discrimination (behavior change)
// ──────────────────────────────────────────────

func TestScanOrphans_canceledCtxSurfacesInsteadOfWarn(t *testing.T) {
	// Behavior change from the merge: ctx now reaches the subprocess, so a
	// canceled scan must error — not masquerade as a bash-less container via
	// the warn-skip path.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	step := 0
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		step++
		if step == 1 {
			return &mockCmd{
				outputFn: func() ([]byte, error) {
					return []byte("cheasee-pi"), nil
				},
			}
		}
		return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("exec failed") }}
	})

	var scanErr error
	stderr := testutil.CaptureStderr(t, func() {
		_, scanErr = scanOrphans(ctx, "cheasee-pi", 0, false)
	})

	if scanErr == nil {
		t.Fatal("canceled scan must return an error")
	}
	if !errors.Is(scanErr, context.Canceled) {
		t.Errorf("error = %v, want context.Canceled", scanErr)
	}
	if strings.Contains(stderr, "orphan scan skipped") {
		t.Errorf("canceled scan must not take the warn-skip path, got: %q", stderr)
	}
}

func TestScanOrphans_liveCtxStillWarns(t *testing.T) {
	// Same exec failure on a live ctx keeps the warn-skip contract: (nil, nil)
	// plus the ⚠ message.
	step := 0
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		step++
		if step == 1 {
			return &mockCmd{
				outputFn: func() ([]byte, error) {
					return []byte("cheasee-pi"), nil
				},
			}
		}
		return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("exec failed") }}
	})

	stderr := testutil.CaptureStderr(t, func() {
		killed, err := scanOrphans(context.Background(), "cheasee-pi", 0, false)
		if err != nil {
			t.Fatalf("live-ctx exec failure must skip, not abort: %v", err)
		}
		if killed != nil {
			t.Errorf("expected nil killed on warn-skip, got %v", killed)
		}
	})
	if !strings.Contains(stderr, "⚠ orphan scan skipped") {
		t.Errorf("live-ctx exec failure must warn, got %q", stderr)
	}
}

// ctxKey is a private context key type for the ctx-reachability tests.

type ctxKey string

func TestScanOrphans_ctxReachesSeam(t *testing.T) {
	// The ctx scanOrphans receives is passed to every seam invocation (both
	// the docker ps gate and the docker exec scan) — previously execCommand
	// had no ctx at all.
	ctx := context.WithValue(context.Background(), ctxKey("test"), "marker")
	var seenCtxs []context.Context
	step := 0
	stubRunCommandContext(t, func(got context.Context, _ string, _ ...string) runner {
		seenCtxs = append(seenCtxs, got)
		step++
		if step == 1 {
			return &mockCmd{
				outputFn: func() ([]byte, error) {
					return []byte("cheasee-pi"), nil
				},
			}
		}
		return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), nil }}
	})

	if _, err := scanOrphans(ctx, "cheasee-pi", 0, false); err != nil {
		t.Fatalf("scanOrphans: %v", err)
	}
	if len(seenCtxs) != 2 {
		t.Fatalf("expected 2 seam invocations (ps + exec), got %d", len(seenCtxs))
	}
	for i, got := range seenCtxs {
		if got.Value(ctxKey("test")) != "marker" {
			t.Errorf("seam call %d did not receive the caller's ctx", i)
		}
	}
}

func TestExecPIContainer_portsThroughSeamWithStdio(t *testing.T) {
	// The SetStdin interface addition is justified by this port: the real
	// execPIContainer body (captured via the package-var seam) must route
	// docker exec through runCommandContext with stdin/stdout/stderr wired
	// then Run.
	env := map[string]string{"KEY": "val"}
	target := "/workspaces/main"
	var m *mockCmd
	var seenArgs []string
	runCalled := false
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			t.Fatalf("execPIContainer must call docker, got %q", name)
		}
		seenArgs = arg
		m = &mockCmd{runFn: func() error { runCalled = true; return nil }}
		return m
	})

	err := execPIContainer("cheasee-pi", env, target)
	if err != nil {
		t.Fatalf("execPIContainer: %v", err)
	}
	if m == nil {
		t.Fatal("seam was not invoked")
	}
	if !slices.Equal(seenArgs, execArgs(env, "cheasee-pi", target)) {
		t.Errorf("seam args = %v, want execArgs output %v", seenArgs, execArgs(env, "cheasee-pi", target))
	}
	if m.stdin != os.Stdin {
		t.Errorf("stdin must be wired to os.Stdin")
	}
	if m.stdout != os.Stdout {
		t.Errorf("stdout must be wired to os.Stdout")
	}
	if m.stderr != os.Stderr {
		t.Errorf("stderr must be wired to os.Stderr")
	}
	if !runCalled {
		t.Errorf("Run must be invoked")
	}
}
