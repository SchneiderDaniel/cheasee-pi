package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// ──────────────────────────────────────────────
// Phase 4: the start-time credential gate
//
// Compose cannot mount the credential without its host source file, so `start`
// refuses BEFORE extraction/build instead of letting Docker fail with an opaque
// bind error after a ~1GB image build. The gate sits after auto-init, which is
// what writes auth.json on a fresh machine.
// ──────────────────────────────────────────────

// testAuthFilePath is the resolved host credential path under the current
// (test-scoped) config home.
func testAuthFilePath(t *testing.T) string {
	t.Helper()
	path, err := (&fileRepository{}).Path()
	if err != nil {
		t.Fatalf("auth path: %v", err)
	}
	if !filepath.IsAbs(path) {
		t.Fatalf("auth path %q must be absolute", path)
	}
	return path
}

func TestEnsureContainerReady_MissingAuthFailsClosed(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)
	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		return &mockCmd{}
	})
	// The host never ran `cheasee-pi auth`: docker would fail on the missing
	// secret source, so start refuses first.
	if err := os.RemoveAll(filepath.Dir(testAuthFilePath(t))); err != nil {
		t.Fatal(err)
	}

	_, err := ensureContainerReady(context.Background(), root, name, false)
	if err == nil {
		t.Fatal("absent credentials must fail closed")
	}
	if !strings.Contains(err.Error(), "cheasee-pi auth") {
		t.Errorf("error must name the recovery command `cheasee-pi auth`, got %v", err)
	}
	for _, argv := range c.composeArgs {
		if slices.Contains(argv, "up") || slices.Contains(argv, "build") {
			t.Errorf("the gate must run before compose, got %v", argv)
		}
	}
}

func TestEnsureContainerReady_AuthPresentProceeds(t *testing.T) {
	// Ordering guard: the gate must not swallow the normal path.
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)
	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		if slices.Contains(arg, "inspect") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
		}
		return &mockCmd{}
	})

	if _, err := ensureContainerReady(context.Background(), root, name, false); err != nil {
		t.Fatalf("ensureContainerReady with credentials present: %v", err)
	}
	var ups int
	for _, argv := range c.composeArgs {
		if slices.Contains(argv, "up") {
			ups++
		}
	}
	if ups != 1 {
		t.Errorf("the normal path must still issue exactly one compose up, got %d: %v", ups, c.composeArgs)
	}
}

func TestStartSession_AuthGateAfterAutoInit(t *testing.T) {
	// Auto-init writes auth.json; the credential gate must sit AFTER it, or the
	// first start of a new machine would refuse the workspace init it just
	// created.
	_, workdir := newWorkspace(t)
	setUpRunMode(t, workdir, false)
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	stubUpFlow(t, workdir, false)
	stubInitGit(t)
	stubAutoInitDeps(t)
	stubExecPIContainer(t)

	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("auto-init run: %v", err)
	}
	if !authJSONExists(t) {
		t.Fatal("fixture precondition: auto-init must write auth.json")
	}

	// Second start: the workspace is initialized and the credentials the init
	// just wrote must satisfy the gate.
	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("start after auto-init must succeed, got %v", err)
		}
	})
	if strings.Contains(stderr, "cheasee-pi auth` on the host") {
		t.Errorf("start after auto-init must not report missing credentials, got: %q", stderr)
	}
}

// TestEnsureContainerReady_LegacyStoppedContainerWarns pins the credential
// drift check to pre-existing containers in EVERY state (issue #2076 audit). A
// stopped container predating the read-only credential mount is only started,
// never recreated, so its read-write config-dir mounts stay in place. Gating
// the check on `running` let that legacy state pass silently on the first start
// after a CLI upgrade.
func TestEnsureContainerReady_LegacyStoppedContainerWarns(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)
	c := stubReadyFlow(t, root, legacyStoppedInspectFn)
	services := stackServices(root)
	c.states = map[string]string{
		name:                  "exited",
		services[1].container: "running",
		services[2].container: "running",
	}

	stderr := testutil.CaptureStderr(t, func() {
		if _, err := ensureContainerReady(context.Background(), root, name, false); err != nil {
			t.Fatalf("ensureContainerReady: %v", err)
		}
	})
	wantSubstrings(t, stderr, "credential", authRecoveryHint)
	if !slices.Contains(c.starts, name) {
		t.Errorf("the stopped container must still be started as-is, got starts %v", c.starts)
	}
}

// TestEnsureContainerReady_FreshContainerSilent is the counterpart guard:
// widening the drift check to every pre-existing container must not make each
// start noisy — a container created on this run carries the fresh stamp.
func TestEnsureContainerReady_FreshContainerSilent(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	name := containerName(root)
	c := stubReadyFlow(t, root, readyHealthInspectFn)
	c.states = map[string]string{}

	stderr := testutil.CaptureStderr(t, func() {
		if _, err := ensureContainerReady(context.Background(), root, name, false); err != nil {
			t.Fatalf("ensureContainerReady: %v", err)
		}
	})
	if strings.Contains(stderr, "Credentials:") {
		t.Errorf("a container created from the current credentials must not warn, got: %q", stderr)
	}
}
