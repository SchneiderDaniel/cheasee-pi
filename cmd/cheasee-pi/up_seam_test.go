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

func TestKillSessionByMarker_ctxReachesSeam(t *testing.T) {
	ctx := context.WithValue(context.Background(), ctxKey("test"), "marker")
	var seen context.Context
	stubRunCommandContext(t, func(got context.Context, _ string, _ ...string) runner {
		seen = got
		return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), nil }}
	})

	if err := killSessionByMarker(ctx, "cheasee-pi", "deadbeef"); err != nil {
		t.Fatalf("killSessionByMarker: %v", err)
	}
	if seen.Value(ctxKey("test")) != "marker" {
		t.Errorf("seam did not receive the caller's ctx")
	}
}

// ──────────────────────────────────────────────
// up.go ports — containerHealth / extractGHToken / execPIContainer
// ──────────────────────────────────────────────

func TestContainerHealth_healthy(t *testing.T) {
	ctx := context.WithValue(context.Background(), ctxKey("test"), "marker")
	var seenCtx context.Context
	var seenArgs []string
	stubRunCommandContext(t, func(got context.Context, name string, arg ...string) runner {
		seenCtx = got
		seenArgs = append([]string{name}, arg...)
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy\n"), nil }}
	})

	status, err := containerHealth(ctx, "cheasee-pi")
	if err != nil {
		t.Fatalf("containerHealth: %v", err)
	}
	if status != "healthy" {
		t.Errorf("status = %q, want %q", status, "healthy")
	}
	if seenCtx.Value(ctxKey("test")) != "marker" {
		t.Errorf("seam must receive the caller's ctx")
	}
	want := []string{"docker", "inspect", "--format", "{{.State.Health.Status}}", "cheasee-pi"}
	if !slices.Equal(seenArgs, want) {
		t.Errorf("seam args = %v, want %v", seenArgs, want)
	}
}

func TestContainerHealth_outputErrorWraps(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon gone") }}
	})

	_, err := containerHealth(context.Background(), "cheasee-pi")
	if err == nil || !strings.Contains(err.Error(), "docker inspect: daemon gone") {
		t.Fatalf("output error must wrap as 'docker inspect: ...', got %v", err)
	}
}

func TestExtractGHToken_trimsOutput(t *testing.T) {
	var seenArgs []string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		seenArgs = append([]string{name}, arg...)
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("gh_token_123\n"), nil }}
	})

	token, err := extractGHToken()
	if err != nil {
		t.Fatalf("extractGHToken: %v", err)
	}
	if token != "gh_token_123" {
		t.Errorf("token = %q, want trimmed %q", token, "gh_token_123")
	}
	want := []string{"gh", "auth", "token"}
	if !slices.Equal(seenArgs, want) {
		t.Errorf("seam args = %v, want %v", seenArgs, want)
	}
}

func TestExtractGHToken_errorPropagatesUnwrapped(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("not logged in") }}
	})

	_, err := extractGHToken()
	if err == nil || !strings.Contains(err.Error(), "not logged in") {
		t.Fatalf("gh failure must propagate, got %v", err)
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
