package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestEnsureContainerReady_alreadyRunningSkipsCompose(t *testing.T) {
	// Running container, no --build: compose is skipped BUT the ready-wait
	// still polls once (the path compose-native --wait can't cover). The
	// drift check read-only-inspects the sidecar first (matching spec → no
	// warning).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)

	var inspectCalls int
	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(name), nil }}
		}
		if slices.Contains(arg, "inspect") {
			inspectCalls++
			if slices.Contains(arg, "{{json .}}") {
				// Drift check: answer with the CURRENT spec (computed at call
				// time — extraction precedes the running check), so a matching
				// start stays silent.
				cacheDir, _ := CacheDir()
				spec, _ := codeflowSpecHash(root, cacheDir)
				return codeflowInspectRunner(mustJSON(codeflowInspectDoc(cacheDir, spec, "")))
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		return &mockCmd{}
	})

	cacheDir, err := ensureContainerReady(context.Background(), root, name, false)
	if err != nil {
		t.Fatalf("ensureContainerReady: %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("running container must skip compose, got %d calls: %v", len(c.composeArgs), c.composeArgs)
	}
	if inspectCalls != 2 {
		t.Errorf("running skip path must drift-check + ready-wait (2 inspects), got %d", inspectCalls)
	}
	wantCache, _ := CacheDir()
	if cacheDir != wantCache {
		t.Errorf("cacheDir = %q, want %q", cacheDir, wantCache)
	}
}

func TestEnsureContainerReady_runningWithBuildForcesCompose(t *testing.T) {
	// Running + --build: compose build+up still invoked (build forces recreate).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)

	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(name), nil }}
		}
		if slices.Contains(arg, "inspect") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		return &mockCmd{}
	})

	if _, err := ensureContainerReady(context.Background(), root, name, true); err != nil {
		t.Fatalf("ensureContainerReady: %v", err)
	}
	if len(c.composeArgs) != 2 {
		t.Errorf("--build must force recreate (build + up) even when running, got %d calls: %v", len(c.composeArgs), c.composeArgs)
	}
}

func TestEnsureContainerReady_psFailsWrapsCheckContainer(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)

	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon gone") }}
		}
		return &mockCmd{}
	})

	_, err := ensureContainerReady(context.Background(), root, containerName(root), false)
	if err == nil || !strings.Contains(err.Error(), "check container:") {
		t.Fatalf("ps failure must wrap as 'check container: ...', got %v", err)
	}
	if !strings.Contains(err.Error(), "docker ps:") {
		t.Errorf("error must carry the underlying docker ps failure, got %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("no compose may run when the container check fails, got %d calls", len(c.composeArgs))
	}
}

func TestEnsureContainerReady_composeFailsWraps(t *testing.T) {
	// Compose build fails → 'docker compose up:' wrap; waitHealthy unreached.
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)

	var inspectCalls int
	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		if slices.Contains(arg, "inspect") {
			inspectCalls++
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		if slices.Contains(arg, "compose") {
			return &mockCmd{runFn: func() error { return fmt.Errorf("compose exploded") }}
		}
		return &mockCmd{}
	})

	_, err := ensureContainerReady(context.Background(), root, containerName(root), false)
	if err == nil || !strings.Contains(err.Error(), "docker compose up:") {
		t.Fatalf("compose failure must wrap as 'docker compose up: ...', got %v", err)
	}
	if len(c.composeArgs) != 1 {
		t.Errorf("compose build failure must stop before the up call, got %d calls: %v", len(c.composeArgs), c.composeArgs)
	}
	if inspectCalls != 0 {
		t.Errorf("waitHealthy must be unreached when compose fails, got %d health polls", inspectCalls)
	}
}
