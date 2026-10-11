package main

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestRunCleanE_confirmAbortStillPrunes(t *testing.T) {
	// Issue-mandated fall-through: abort skips kill/remove but still prunes
	// dangling images + build cache at the function tail.
	resetCleanState(t)
	saved := cleanConfirmFn
	cleanConfirmFn = func(string) (bool, error) { return false, nil }
	t.Cleanup(func() { cleanConfirmFn = saved })

	execCalls := 0
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		if len(arg) > 0 && arg[0] == "exec" {
			execCalls++
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte("killing 42 (age 60m)\n"), nil }}
		}
		if len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("cheasee-pi\n"), nil }}
		}
		if slices.Contains(arg, "images") {
			// A dangling image exists → the prune actually runs.
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("sha256:abc\n"), nil }}
		}
		return &mockCmd{combinedFn: func() ([]byte, error) { return nil, nil }}
	})
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if execCalls != 1 {
		t.Errorf("aborted clean must only preview (one scan), got %d", execCalls)
	}
	if !strings.Contains(stderr, "Aborted") {
		t.Errorf("abort must be reported, got %q", stderr)
	}
	if strings.Contains(stderr, "Killed") || strings.Contains(stderr, "Removed container") {
		t.Errorf("abort must not kill or remove, got %q", stderr)
	}
	if !strings.Contains(stderr, "Pruned dangling Docker images") {
		t.Errorf("abort must still prune dangling images, got %q", stderr)
	}
	if !strings.Contains(stderr, "Pruned Docker build cache") {
		t.Errorf("abort must still prune build cache, got %q", stderr)
	}
}

func TestRunCleanE_confirmPromptUsesHoistedCandidates(t *testing.T) {
	// The confirm prompt must consume the hoisted preview candidates instead
	// of re-scanning: exact prompt + two scans total (preview + real kill).
	resetCleanState(t)
	prompt := "not-called"
	saved := cleanConfirmFn
	cleanConfirmFn = func(p string) (bool, error) { prompt = p; return true, nil }
	t.Cleanup(func() { cleanConfirmFn = saved })

	calls := cleanTestStub(t, "cheasee-pi", "killing 42 (age 60m)\n")
	testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if *calls != 2 {
		t.Errorf("confirmed clean must preview then kill (two scans), got %d", *calls)
	}
	if want := "Kill 1 pi session(s) and remove 1 container(s)?"; prompt != want {
		t.Errorf("prompt must reuse hoisted candidates, got %q, want %q", prompt, want)
	}
}

func TestRunCleanE_pruneConfirmations(t *testing.T) {
	resetCleanState(t)
	cleanYes = true
	cleanMaxAge = 0

	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		if len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("cheasee-pi\n"), nil }}
		}
		if len(arg) > 0 && arg[0] == "exec" {
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		if slices.Contains(arg, "images") {
			// A dangling image exists → the prune actually runs.
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("sha256:abc\n"), nil }}
		}
		return &mockCmd{combinedFn: func() ([]byte, error) { return nil, nil }}
	})
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if !strings.Contains(stderr, "Pruned dangling Docker images") {
		t.Errorf("dangling-image prune confirmation missing, got %q", stderr)
	}
	if !strings.Contains(stderr, "Pruned Docker build cache") {
		t.Errorf("build-cache prune confirmation missing, got %q", stderr)
	}
}
