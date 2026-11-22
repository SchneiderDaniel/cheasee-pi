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
	discoveryRequireNoErr(t, "recordInstance", recordInstance(context.Background(), reg, root))
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
