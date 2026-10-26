package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestRunUpE_containerCheckErrorPropagatesUnwrapped(t *testing.T) {
	// docker ps fails via seam → runUpE returns the helper error verbatim
	// ('check container:' exactly once — no double-wrap, per the diff).
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)

	stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon gone") }}
		}
		return &mockCmd{}
	})

	err := runUpE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "check container:") {
		t.Fatalf("ps failure must surface through runUpE, got %v", err)
	}
	if strings.Count(err.Error(), "check container:") != 1 {
		t.Errorf("helper error must not be double-wrapped, got %q", err)
	}
	if !strings.Contains(err.Error(), "docker ps:") {
		t.Errorf("error must carry the underlying docker ps failure, got %q", err)
	}
}

func TestRunUpE_waitHealthyTimeoutSurfaces(t *testing.T) {
	// healthWaitTimeout→1ns + inspect→'starting' → the waitHealthy timeout
	// surfaces unchanged through runUpE.
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)

	saved := healthWaitTimeout
	healthWaitTimeout = time.Nanosecond
	t.Cleanup(func() { healthWaitTimeout = saved })

	stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		if slices.Contains(arg, "inspect") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("starting"), nil }}
		}
		return &mockCmd{}
	})

	err := runUpE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "not healthy after") {
		t.Fatalf("health-wait timeout must surface through runUpE, got %v", err)
	}
	if !strings.Contains(err.Error(), "docker logs") {
		t.Errorf("error must carry the docker logs hint, got %q", err)
	}
}

// ──────────────────────────────────────────────
// First-build gate + notice (ensureContainerReady use cases)
// ──────────────────────────────────────────────

// readyFlowDockerFn is the dockerFn used by the container-ready use-case
// tests: the whole stack is present (running) or absent, the health-wait
// inspect answers healthy, and the drift `{{json .}}` inspect (running &&
// !build only) answers a label-less sidecar whose config.json mount matches
// the current cache dir — old-container form, silent when fields match.

func readyFlowDockerFn(root string, running bool) func(context.Context, []string) runner {
	return func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) {
				out := ""
				if running {
					for _, s := range stackServices(root) {
						out += s.container + "|running\n"
					}
				}
				return []byte(out), nil
			}}
		}
		if slices.Contains(arg, "inspect") {
			if slices.Contains(arg, "{{json .}}") {
				cacheDir, _ := CacheDir()
				return codeflowInspectRunner(mustJSON(codeflowInspectDoc(cacheDir, "", "")))
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		return &mockCmd{}
	}
}

func TestEnsureContainerReady_imageMissingPrintsFirstBuildNotice(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)

	c := stubReadyFlow(t, root, readyFlowDockerFn(root, false)) // nothing exists, image missing (stub default)
	stderr := testutil.CaptureStderr(t, func() {
		if _, err := ensureContainerReady(context.Background(), root, name, false); err != nil {
			t.Fatalf("ensureContainerReady: %v", err)
		}
	})

	// Static substrings only — no computed size/duration.
	for _, want := range []string{"First start downloads", "~1GB", "several minutes"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("first-build notice must contain %q, got: %q", want, stderr)
		}
	}
	if n := strings.Count(stderr, "First start downloads"); n != 1 {
		t.Errorf("notice must appear exactly once, got %d in: %q", n, stderr)
	}
	i, j := strings.Index(stderr, "First start downloads"), strings.Index(stderr, "Building container image...")
	if i < 0 || j < 0 || i > j {
		t.Errorf("notice (idx %d) must precede the build label (idx %d), stderr: %q", i, j, stderr)
	}
	// The gate changes only the notice — compose still builds + up.
	if len(c.composeArgs) != 2 {
		t.Errorf("missing image must still build + up, got %d calls: %v", len(c.composeArgs), c.composeArgs)
	}
}

func TestEnsureContainerReady_imagePresentColdStartReusesImage(t *testing.T) {
	// Cached images, no containers: the containers are created without a build
	// and without the ~1GB first-build notice — keying a build on !running
	// alone would rebuild on every cached cold start.
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)

	c := stubReadyFlow(t, root, readyFlowDockerFn(root, false))
	c.imageState = upImagePresent
	stderr := testutil.CaptureStderr(t, func() {
		if _, err := ensureContainerReady(context.Background(), root, name, false); err != nil {
			t.Fatalf("ensureContainerReady: %v", err)
		}
	})
	if strings.Contains(stderr, "First start downloads") {
		t.Errorf("cached image must not print the first-build notice, got: %q", stderr)
	}
	if len(c.composeArgs) != 1 {
		t.Fatalf("present images + missing containers must only create, got %v", c.composeArgs)
	}
	if !slices.Contains(c.composeArgs[0], "up") || slices.Contains(c.composeArgs[0], "build") {
		t.Errorf("create-only path must not build, got %v", c.composeArgs[0])
	}
}
