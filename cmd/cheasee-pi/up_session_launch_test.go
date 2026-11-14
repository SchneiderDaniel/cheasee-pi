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
