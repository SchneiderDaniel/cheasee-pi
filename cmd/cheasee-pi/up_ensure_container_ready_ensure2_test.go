package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestEnsureContainerReady_extractFailsWraps(t *testing.T) {
	// Pre-create <cacheDir>/lib as a regular file: the extractor's MkdirAll
	// for the lib/ dir hits ENOTDIR (root-safe, no chmod) → 'extract compose
	// files:' wrap and 0 docker calls (extract precedes any docker work).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir, err := CacheDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "lib"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	var dockerCalls int
	c := stubReadyFlow(t, root, func(_ context.Context, _ []string) runner {
		dockerCalls++
		return &mockCmd{}
	})

	_, err = ensureContainerReady(context.Background(), root, containerName(root), false)
	if err == nil || !strings.Contains(err.Error(), "extract compose files:") {
		t.Fatalf("extract failure must wrap as 'extract compose files: ...', got %v", err)
	}
	if dockerCalls != 0 {
		t.Errorf("extract must precede any docker call, got %d", dockerCalls)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("no compose may run when extract fails, got %d calls", len(c.composeArgs))
	}
}

func TestEnsureContainerReady_preCancelledCtxFailsFast(t *testing.T) {
	// Pre-cancelled ctx fails at the cache-dir gate before any docker work —
	// the helper-level analog of the dry-run-touches-nothing invariant.
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)

	var dockerCalls int
	stubReadyFlow(t, root, func(_ context.Context, _ []string) runner {
		dockerCalls++
		return &mockCmd{}
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := ensureContainerReady(ctx, root, "nope", false)
	if err == nil || !strings.Contains(err.Error(), "cache dir: context canceled") {
		t.Fatalf("pre-cancelled ctx must fail at the cache-dir gate, got %v", err)
	}
	if dockerCalls != 0 {
		t.Errorf("pre-cancelled ctx must not reach docker, got %d calls", dockerCalls)
	}
}

func TestEnsureContainerReady_notHealthyTimesOut(t *testing.T) {
	// Not healthy past the timeout → waitHealthy's raw message surfaces with
	// NO helper wrap prefix (the diff returns it unwrapped).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)

	saved := healthWaitTimeout
	healthWaitTimeout = time.Nanosecond
	t.Cleanup(func() { healthWaitTimeout = saved })

	name := containerName(root)
	stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		if slices.Contains(arg, "inspect") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("starting"), nil }}
		}
		return &mockCmd{}
	})

	_, err := ensureContainerReady(context.Background(), root, name, false)
	if err == nil {
		t.Fatal("expected the health-wait timeout error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "not healthy after") || !strings.Contains(msg, "docker logs") {
		t.Errorf("error must be waitHealthy's raw message, got %q", msg)
	}
	if !strings.Contains(msg, name) {
		t.Errorf("error must name the container, got %q", msg)
	}
	for _, prefix := range []string{"cache dir:", "extract compose files:", "check container:", "docker compose up:"} {
		if strings.Contains(msg, prefix) {
			t.Errorf("timeout error must not carry the %q wrap prefix, got %q", prefix, msg)
		}
	}
}

func TestEnsureContainerReady_ctxForwardedToSeams(t *testing.T) {
	// Marker-value ctx must reach the docker ps AND docker inspect seam calls
	// unchanged — guards the issue snippet's containerRunning(name) trap
	// (the real signature is containerRunning(ctx, name)).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)

	ctx := context.WithValue(context.Background(), ctxKey("marker"), "v")
	var seen []context.Context
	stubReadyFlow(t, root, func(got context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") || slices.Contains(arg, "inspect") {
			seen = append(seen, got)
		}
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		if slices.Contains(arg, "inspect") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		return &mockCmd{}
	})

	if _, err := ensureContainerReady(ctx, root, name, false); err != nil {
		t.Fatalf("ensureContainerReady: %v", err)
	}
	if len(seen) != 3 { // containerRunning ps + state probe ps + health inspect
		t.Fatalf("expected 2 ps + inspect seam calls, got %d", len(seen))
	}
	for i, got := range seen {
		if got.Value(ctxKey("marker")) != "v" {
			t.Errorf("seam call %d did not receive the caller's ctx", i)
		}
	}
}

// ──────────────────────────────────────────────
// runUpE orchestrator regression (new use cases)
// ──────────────────────────────────────────────
