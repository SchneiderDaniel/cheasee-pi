package main

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestEnsureContainerReady_runningNoBuildNoGateNoCompose(t *testing.T) {
	// Running container, no --build: no compose AND no image-inspect gate
	// call — the gate is computed only when a build will actually run (the
	// health-wait inspect still happens).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)

	c := stubReadyFlow(t, root, readyFlowDockerFn(name))
	stderr := testutil.CaptureStderr(t, func() {
		if _, err := ensureContainerReady(context.Background(), root, name, false); err != nil {
			t.Fatalf("ensureContainerReady: %v", err)
		}
	})
	if len(c.composeArgs) != 0 {
		t.Errorf("running container must skip compose, got %d calls", len(c.composeArgs))
	}
	if c.imageGates != 0 {
		t.Errorf("gate must not run when no build will run, got %d image-inspect calls", c.imageGates)
	}
	if strings.Contains(stderr, "First start downloads") {
		t.Errorf("no build → no notice, got: %q", stderr)
	}
}

func TestEnsureContainerReady_buildForcedRespectsImagePresence(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)

	// --build + image present → build forced, NO notice (cached layers).
	c := stubReadyFlow(t, root, readyFlowDockerFn(name))
	c.imageState = upImagePresent
	stderr := testutil.CaptureStderr(t, func() {
		if _, err := ensureContainerReady(context.Background(), root, name, true); err != nil {
			t.Fatalf("ensureContainerReady: %v", err)
		}
	})
	if len(c.composeArgs) != 2 {
		t.Errorf("--build must force build + up, got %d calls", len(c.composeArgs))
	}
	if strings.Contains(stderr, "First start downloads") {
		t.Errorf("--build with cached layers must not nag, got: %q", stderr)
	}

	// --build + image missing → notice printed (the build genuinely
	// re-downloads what clean/prune removed).
	c2 := stubReadyFlow(t, root, readyFlowDockerFn(name))
	stderr2 := testutil.CaptureStderr(t, func() {
		if _, err := ensureContainerReady(context.Background(), root, name, true); err != nil {
			t.Fatalf("ensureContainerReady: %v", err)
		}
	})
	if !strings.Contains(stderr2, "First start downloads") {
		t.Errorf("--build with no image must print the notice, got: %q", stderr2)
	}
	if c2.imageGates != 1 {
		t.Errorf("--build must run the gate exactly once, got %d", c2.imageGates)
	}
}

func TestEnsureContainerReady_imageDaemonErrorFailsClosed(t *testing.T) {
	// Inspect non-1 exit → wrapped 'check image:' error, compose never
	// invoked (inspect precedes build — fail-closed ordering).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)

	c := stubReadyFlow(t, root, readyFlowDockerFn(""))
	c.imageState = upImageDaemonError
	_, err := ensureContainerReady(context.Background(), root, name, false)
	if err == nil || !strings.Contains(err.Error(), "check image:") {
		t.Fatalf("inspect failure must wrap as 'check image: ...', got %v", err)
	}
	if !strings.Contains(err.Error(), "docker image inspect") {
		t.Errorf("error must carry the inspect command, got %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("fail-closed: compose must never run when the gate errors, got %d calls", len(c.composeArgs))
	}
}

func TestEnsureContainerReady_runningStaleSidecarWarns(t *testing.T) {
	// Running container + stale sidecar (older cache-dir config.json mount,
	// old port binding, old stamp): compose stays skipped (zero
	// invocations), the ready-wait still polls, and stderr names the drift
	// with the exact recovery command.
	_, root := mkWorkspace(t, `{"docker": {"codeflowPort": "9100"}}`)
	setUpReady(t)
	name := containerName(root)

	var inspectCalls int
	staleCache := filepath.Join(t.TempDir(), "cheasee-pi", "0.54.0")
	staleJSON := mustJSON(codeflowInspectDoc(staleCache, strings.Repeat("0", 64), "9000"))
	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(name), nil }}
		}
		if slices.Contains(arg, "inspect") {
			inspectCalls++
			if slices.Contains(arg, "{{json .}}") {
				return codeflowInspectRunner(staleJSON)
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		return &mockCmd{}
	})

	stderr := testutil.CaptureStderr(t, func() {
		if _, err := ensureContainerReady(context.Background(), root, name, false); err != nil {
			t.Fatalf("ensureContainerReady: %v", err)
		}
	})
	if len(c.composeArgs) != 0 {
		t.Errorf("stale sidecar must still skip compose (warn-don't-act), got %d calls: %v", len(c.composeArgs), c.composeArgs)
	}
	if inspectCalls != 2 {
		t.Errorf("running path must drift-check + ready-wait (2 inspects), got %d", inspectCalls)
	}
	for _, want := range []string{"stale", "config.json", "9000", "9100", "cheasee-pi start --build", "cheasee-pi down"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stale warning must carry %q, got: %q", want, stderr)
		}
	}
}
