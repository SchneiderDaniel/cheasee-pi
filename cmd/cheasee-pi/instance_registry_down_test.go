package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// ──────────────────────────────────────────────
// Phase 5 (cont.): registry lifecycle on down
//
// A stop deregisters this workspace's record and nothing else, and a failed
// compose down keeps the record (the container may still be running).
// ──────────────────────────────────────────────

// discoveryDownFixture is one workspace with a registered instance, a stubbed
// docker seam and the cwd inside the workspace. The returned mock is the
// compose-down invocation, so a test can force it to fail.
func discoveryDownFixture(t *testing.T, psOutput string) (root string, reg InstanceRegistry, downCmd *mockCmd) {
	t.Helper()
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PI_UI_PORT", "")
	t.Setenv("CODEFLOW_PORT", "")
	stubPortProbe(t, true)

	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/repo-a.git")
	reg = newFileInstanceRegistry(mustRegistryDir(t))
	discoveryRequireNoErr(t, "recordInstance", recordInstance(context.Background(), reg, root))
	chdir(t, root)
	downCmd, _ = stubDownFlow(t, psOutput)
	return root, reg, downCmd
}

// runDownQuietly runs `down` with stderr captured, failing the test on error.
func runDownQuietly(t *testing.T) {
	t.Helper()
	testutil.CaptureStderr(t, func() {
		if err := runDownE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runDownE: %v", err)
		}
	})
}

func TestDiscovery_runDownERemovesOwnRecord(t *testing.T) {
	root, reg, _ := discoveryDownFixture(t, "cheasee-pi-alice-repo-a\n")
	runDownQuietly(t)

	discoveryRequireRecordCount(t, reg, 0)
	discoveryRequireAbsent(t, "own record file", filepath.Join(mustRegistryDir(t), instanceKey(root)+".json"))
}

func TestDiscovery_runDownEKeepsSiblingRecord(t *testing.T) {
	root, reg, _ := discoveryDownFixture(t, "cheasee-pi-alice-repo-a\n")
	// A sibling workspace's record — down must never deregister it.
	sibling := discoveryRecord("alice-repo-a-ffffffff")
	sibling.Label = "alice-repo-a (ws2)"
	discoveryRequireNoErr(t, "Record(sibling)", reg.Record(sibling))

	runDownQuietly(t)
	if got := discoveryRequireRecordCount(t, reg, 1); got[0] != sibling {
		t.Errorf("List = %+v, want only the sibling record %+v", got[0], sibling)
	}
	discoveryRequireAbsent(t, "own record file", filepath.Join(mustRegistryDir(t), instanceKey(root)+".json"))
}

func TestDiscovery_runDownEFailureKeepsRecord(t *testing.T) {
	_, reg, downCmd := discoveryDownFixture(t, "cheasee-pi-alice-repo-a\n")
	downCmd.runFn = func() error { return os.ErrPermission }

	testutil.CaptureStderr(t, func() {
		if err := runDownE(&cobra.Command{}, nil); err == nil {
			t.Fatal("a failed compose down must return an error")
		}
	})
	discoveryRequireRecordCount(t, reg, 1)
}

func TestDiscovery_runDownENoRecordStillSucceeds(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/repo-a.git")
	chdir(t, root)
	reg := newFileInstanceRegistry(mustRegistryDir(t))
	sibling := discoveryRecord("alice-repo-a-ffffffff")
	discoveryRequireNoErr(t, "Record(sibling)", reg.Record(sibling))
	stubDownFlow(t, "")

	runDownQuietly(t)
	if got := discoveryRequireRecordCount(t, reg, 1); got[0] != sibling {
		t.Errorf("List = %+v, want the sibling record untouched", got[0])
	}
}
