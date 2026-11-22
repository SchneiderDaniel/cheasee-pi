package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// errDaemonGone is the probe failure the snapshot and mount tests share.
var errDaemonGone = errors.New("daemon gone")

// ──────────────────────────────────────────────
// Phase 6 (cont.): snapshot determinism, path-freedom, fail-closed materialisation
// ──────────────────────────────────────────────

func TestDiscovery_snapshotIsDeterministicAndPathFree(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PI_UI_PORT", "")
	t.Setenv("CODEFLOW_PORT", "")
	stubPortProbe(t, true)

	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/foo.git")
	reg := newFileInstanceRegistry(mustRegistryDir(t))
	discoveryRequireNoErr(t, "recordInstance", recordInstance(context.Background(), reg, root, containerName(root)))
	stubSnapshotStates(t, containerName(root)+"|running\n", nil)

	path := discoverySnapshotPath(t)
	discoveryRequireNoErr(t, "writeInstanceSnapshot", writeInstanceSnapshot(context.Background(), reg, path))
	first := readSnapshotBytes(t, path)
	discoveryRequireNoErr(t, "writeInstanceSnapshot (second)", writeInstanceSnapshot(context.Background(), reg, path))
	if second := readSnapshotBytes(t, path); string(first) != string(second) {
		t.Errorf("snapshot must be byte-identical across writes:\n%s\n%s", first, second)
	}
	for _, leak := range []string{root, parent, filepath.Dir(root)} {
		if strings.Contains(string(first), leak) {
			t.Errorf("snapshot must not contain the host path %q: %s", leak, first)
		}
	}
}

// readSnapshotBytes reads the snapshot file verbatim.
func readSnapshotBytes(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	discoveryRequireNoErr(t, "read snapshot", err)
	return raw
}

func TestDiscovery_ensureSnapshotFallsBackToEmptyOnCorruptRegistry(t *testing.T) {
	// A corrupt peer record must not block a start, and the ui service's mount
	// target must still exist as a FILE (docker would otherwise create a
	// directory there). The fault is reported, never swallowed.
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	dir := mustRegistryDir(t)
	discoveryRequireNoErr(t, "create registry dir", os.MkdirAll(dir, 0o755))
	discoveryRequireNoErr(t, "write corrupt record", os.WriteFile(filepath.Join(dir, "broken-00000000.json"), []byte("{not json"), 0o644))
	path, err := instanceSnapshotPath()
	discoveryRequireNoErr(t, "instanceSnapshotPath", err)

	err = ensureInstanceSnapshot(context.Background())
	if err == nil {
		t.Fatal("a corrupt registry must be reported, got nil error")
	}
	discoveryRequireContains(t, "corrupt-registry error", err.Error(), "broken-00000000.json")
	if got := strings.TrimSpace(string(readSnapshotBytes(t, path))); got != "[]" {
		t.Errorf("fallback snapshot = %q, want an empty list", got)
	}
	// Idempotent: an existing snapshot is left alone (the content is refreshed
	// after the stack is up).
	discoveryRequireNoErr(t, "existing snapshot must satisfy the pre-compose step", ensureInstanceSnapshot(context.Background()))
}

// ──────────────────────────────────────────────
// Snapshot invalidation on a failing resolution (#2155 audit finding 1)
//
// A snapshot published while the host view was known must not survive a later
// failure: the sidecar would keep listing running peers and render connect
// links to stacks the CLI can no longer confirm. The published view is
// invalidated to an empty list and the fault is returned.
// ──────────────────────────────────────────────

// discoverySeedRunningSnapshot publishes a one-row snapshot claiming the
// record's container is running, and returns the snapshot path.
func discoverySeedRunningSnapshot(t *testing.T, reg InstanceRegistry, rec InstanceRecord) string {
	t.Helper()
	stubSnapshotStates(t, containerNameFromKey(rec.Key)+"|running\n", nil)
	path := discoverySnapshotPath(t)
	discoveryRequireNoErr(t, "writeInstanceSnapshot (seed)", writeInstanceSnapshot(context.Background(), reg, path))
	if rows := readSnapshot(t, path); len(rows) != 1 || rows[0]["running"] != true {
		t.Fatalf("seed snapshot = %v, want exactly one running entry", rows)
	}
	return path
}

// discoveryRequireInvalidatedSnapshot asserts path still exists as a FILE
// carrying the empty list — the mount target survives, the stale claim does not.
func discoveryRequireInvalidatedSnapshot(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	discoveryRequireNoErr(t, "stat snapshot", err)
	if info.IsDir() {
		t.Fatalf("snapshot target %s must stay a FILE (the ui bind mount)", path)
	}
	if rows := readSnapshot(t, path); len(rows) != 0 {
		t.Errorf("snapshot = %v, want an empty list so no stale instance is advertised", rows)
	}
}

func TestDiscovery_snapshotProbeFailureInvalidatesStaleSnapshot(t *testing.T) {
	rec := discoveryRecord("alice-foo-00000000")
	reg := discoverySnapshotRegistry(t, rec)
	path := discoverySeedRunningSnapshot(t, reg, rec)

	// Docker becomes unreachable: the fault surfaces AND the stale claim goes.
	stubSnapshotStates(t, "", errDaemonGone)
	err := writeInstanceSnapshot(context.Background(), reg, path)
	if err == nil {
		t.Fatal("a failing liveness probe must surface, got nil error")
	}
	discoveryRequireContains(t, "probe-failure error", err.Error(), "docker ps:")
	discoveryRequireInvalidatedSnapshot(t, path)
}

func TestDiscovery_snapshotRegistryFailureInvalidatesStaleSnapshot(t *testing.T) {
	// The same class of fault from the other side: a corrupt peer record makes
	// the listing unknowable, so the published view must not survive either.
	rec := discoveryRecord("alice-foo-00000000")
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	discoveryRequireNoErr(t, "Record", reg.Record(rec))
	path := discoverySeedRunningSnapshot(t, reg, rec)
	discoveryRequireNoErr(t, "write corrupt record", os.WriteFile(filepath.Join(dir, "broken-00000000.json"), []byte("{not json"), 0o644))

	err := writeInstanceSnapshot(context.Background(), reg, path)
	if err == nil {
		t.Fatal("a corrupt registry must surface, got nil error")
	}
	discoveryRequireContains(t, "corrupt-registry error", err.Error(), "broken-00000000.json")
	discoveryRequireInvalidatedSnapshot(t, path)
}
