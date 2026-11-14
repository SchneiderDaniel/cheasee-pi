package main

import (
	"context"
	"slices"
	"testing"
)

// isPiExecCall reports whether a docker invocation is the interactive pi exec
// (as opposed to the session reaper's `docker exec <name> bash -c …`).
func isPiExecCall(name string, arg []string) bool {
	return name == "docker" && len(arg) > 0 && arg[0] == "exec" && slices.Contains(arg, "-it")
}

// isSessionReapCall reports whether a docker invocation is the session reaper
// (the non-interactive `docker exec <name> bash -c <kill-by-marker script>`).
func isSessionReapCall(name string, arg []string) bool {
	return name == "docker" && len(arg) > 0 && arg[0] == "exec" && !slices.Contains(arg, "-it")
}

// TestExecPiSession_ctxReachesTheExecSeam pins the exec adapter's ctx
// plumbing: the `docker exec -it pi` client must be started on the caller's
// ctx, not context.Background(). Without it a cancel (Ctrl-C, signal handler,
// parent timeout) leaves the exec process running after the use case gave up,
// and the session reaper cannot run until it exits on its own.
func TestExecPiSession_ctxReachesTheExecSeam(t *testing.T) {
	var (
		execCtx context.Context
		sawExec bool
	)
	stubRunCommandContext(t, func(got context.Context, name string, arg ...string) runner {
		if isPiExecCall(name, arg) {
			execCtx, sawExec = got, true
		}
		return &mockCmd{
			runFn:      func() error { return nil },
			outputFn:   func() ([]byte, error) { return []byte(""), nil },
			combinedFn: func() ([]byte, error) { return []byte(""), nil },
		}
	})

	ctx := context.WithValue(context.Background(), ctxKey("test"), "marker")
	if err := execPiSession(ctx, "cheasee-pi", map[string]string{"K": "v"},
		"/workspaces/main", "deadbeef"); err != nil {
		t.Fatalf("execPiSession: %v", err)
	}
	if !sawExec {
		t.Fatal("the exec seam never ran `docker exec -it`")
	}
	if got := execCtx.Value(ctxKey("test")); got != "marker" {
		t.Errorf("the exec seam must receive the caller's ctx, got %v", got)
	}
	if execCtx != ctx {
		t.Error("the exec seam must run on the caller's ctx, not a fresh background ctx")
	}
}

// TestExecPiSession_cancellationReachesTheExecSeam proves the ctx is live, not
// just copied: a ctx cancelled before the call is already Done inside the
// adapter, so an in-flight docker exec is torn down by cancellation.
func TestExecPiSession_cancellationReachesTheExecSeam(t *testing.T) {
	var (
		execCtx context.Context
		sawExec bool
	)
	stubRunCommandContext(t, func(got context.Context, name string, arg ...string) runner {
		if isPiExecCall(name, arg) {
			execCtx, sawExec = got, true
		}
		return &mockCmd{
			runFn:      func() error { return nil },
			outputFn:   func() ([]byte, error) { return []byte(""), nil },
			combinedFn: func() ([]byte, error) { return []byte(""), nil },
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := execPiSession(ctx, "cheasee-pi", map[string]string{"K": "v"},
		"/workspaces/main", "deadbeef"); err != nil {
		t.Fatalf("execPiSession: %v", err)
	}
	if !sawExec {
		t.Fatal("the exec seam never ran `docker exec -it`")
	}
	if err := execCtx.Err(); err != context.Canceled {
		t.Errorf("the exec seam ctx = %v, want a cancelled ctx", err)
	}
}

// TestExecPiSession_reapSurvivesCancellation pins the other half of the
// cancellation contract documented on execPiSession: the reap runs even when
// the start was torn down. A cancelled ctx makes the reaper's own docker exec
// fail instantly, which would leak the very session the reap exists to kill —
// so the reap must run detached from cancellation while still carrying the
// caller's ctx values.
func TestExecPiSession_reapSurvivesCancellation(t *testing.T) {
	var (
		reapCtx     context.Context
		reapErr     error
		reapBounded bool
		sawReap     bool
	)
	stubRunCommandContext(t, func(got context.Context, name string, arg ...string) runner {
		if isSessionReapCall(name, arg) {
			sawReap = true
			reapCtx = got
			// Snapshot the live state: execPiSession cancels its own reap
			// ctx on return, so the seam is the only place that sees it in
			// flight.
			reapErr = got.Err()
			_, reapBounded = got.Deadline()
		}
		return &mockCmd{
			runFn:      func() error { return nil },
			outputFn:   func() ([]byte, error) { return []byte(""), nil },
			combinedFn: func() ([]byte, error) { return []byte(""), nil },
		}
	})

	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), ctxKey("test"), "marker"))
	cancel()

	if err := execPiSession(ctx, "cheasee-pi", map[string]string{"K": "v"},
		"/workspaces/main", "deadbeef"); err != nil {
		t.Fatalf("execPiSession: %v", err)
	}
	if !sawReap {
		t.Fatal("the session reaper never ran")
	}
	if reapErr != nil {
		t.Errorf("the reap must not inherit cancellation, got ctx error %v", reapErr)
	}
	if got := reapCtx.Value(ctxKey("test")); got != "marker" {
		t.Errorf("the reap must keep the caller's ctx values, got %v", got)
	}
	if !reapBounded {
		t.Error("the detached reap must still be time-bounded by a deadline")
	}
}
