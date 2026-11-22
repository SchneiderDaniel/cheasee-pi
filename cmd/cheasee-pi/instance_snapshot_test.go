package main

import (
	"context"
	"slices"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 6: read-only instance snapshot
//
// The ui sidecar is not allowed a host or docker view (docs/security.md), so
// discovery is served by one CLI-written snapshot file bind-mounted read-only
// into the `ui` service. Liveness is resolved at write time from `docker ps -a`,
// never trusted from the registry file (a host crash leaves stale records).
// ──────────────────────────────────────────────

// stubSnapshotStates answers the container-state probe with the exact
// `{{.Names}}|{{.State}}` lines the snapshot builder parses.
func stubSnapshotStates(t *testing.T, lines string, probeErr error) {
	t.Helper()
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" || !slices.Contains(arg, "ps") {
			return &mockCmd{}
		}
		if probeErr != nil {
			err := probeErr
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, err }}
		}
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte(lines), nil }}
	})
}

// discoverySnapshotRegistry seeds a temp registry with the given records.
func discoverySnapshotRegistry(t *testing.T, records ...InstanceRecord) InstanceRegistry {
	t.Helper()
	reg := newFileInstanceRegistry(t.TempDir())
	for _, rec := range records {
		discoveryRequireNoErr(t, "Record", reg.Record(rec))
	}
	return reg
}

// writeSnapshotTo writes the snapshot for reg into a fresh temp path and
// returns the decoded rows.
func writeSnapshotTo(t *testing.T, reg InstanceRegistry) []map[string]any {
	t.Helper()
	path := discoverySnapshotPath(t)
	discoveryRequireNoErr(t, "writeInstanceSnapshot", writeInstanceSnapshot(context.Background(), reg, path))
	return readSnapshot(t, path)
}

func TestDiscovery_snapshotListsRunningInstances(t *testing.T) {
	zeta := discoveryRecord("alice-foo-ffffffff")
	zeta.Label = "alice-foo (ws2)"
	alpha := discoveryRecord("alice-foo-00000000")
	alpha.Label = "alice-foo (ws1)"
	// Recorded out of key order on purpose: the snapshot orders by key.
	reg := discoverySnapshotRegistry(t, zeta, alpha)
	stubSnapshotStates(t, containerNameFromKey(alpha.Key)+"|running\n"+containerNameFromKey(zeta.Key)+"|running\n", nil)

	doc := writeSnapshotTo(t, reg)
	if len(doc) != 2 {
		t.Fatalf("snapshot = %v, want two entries", doc)
	}
	if doc[0]["key"] != alpha.Key || doc[1]["key"] != zeta.Key {
		t.Errorf("snapshot order = %v, %v — want key order", doc[0]["key"], doc[1]["key"])
	}
	for _, entry := range doc {
		discoveryRequireSnapshotKeys(t, entry)
		if entry["running"] != true {
			t.Errorf("entry %v must be running", entry["key"])
		}
		if entry["uiPort"] == nil || entry["uiPort"] == "" {
			t.Errorf("entry %v must carry the ui port", entry["key"])
		}
	}
}

// discoveryRequireSnapshotKeys asserts one snapshot row carries exactly the
// documented fields (no host paths, no docker objects).
func discoveryRequireSnapshotKeys(t *testing.T, entry map[string]any) {
	t.Helper()
	keys := make([]string, 0, len(entry))
	for key := range entry {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	if want := []string{"key", "label", "running", "uiPort"}; !slices.Equal(keys, want) {
		t.Errorf("entry keys = %v, want exactly %v", keys, want)
	}
}

func TestDiscovery_snapshotOmitsStaleRecords(t *testing.T) {
	// A record whose container is gone is a stale record (host crash, manual
	// rm): it must not surface as an available instance.
	live := discoveryRecord("alice-foo-00000000")
	gone := discoveryRecord("alice-foo-ffffffff")
	reg := discoverySnapshotRegistry(t, live, gone)
	stubSnapshotStates(t, containerNameFromKey(live.Key)+"|running\n", nil)

	doc := writeSnapshotTo(t, reg)
	if len(doc) != 1 || doc[0]["key"] != live.Key {
		t.Fatalf("snapshot = %v, want only the live instance %q", doc, live.Key)
	}
}

func TestDiscovery_snapshotReportsStoppedContainer(t *testing.T) {
	rec := discoveryRecord("alice-foo-00000000")
	reg := discoverySnapshotRegistry(t, rec)
	stubSnapshotStates(t, containerNameFromKey(rec.Key)+"|exited\n", nil)

	doc := writeSnapshotTo(t, reg)
	if len(doc) != 1 {
		t.Fatalf("snapshot = %v, want one entry", doc)
	}
	if doc[0]["running"] != false {
		t.Errorf("an exited container must be listed as not running, got %v", doc[0])
	}
}

func TestDiscovery_snapshotProbeFailureWritesNothing(t *testing.T) {
	reg := discoverySnapshotRegistry(t, discoveryRecord("alice-foo-00000000"))
	stubSnapshotStates(t, "", errDaemonGone)

	path := discoverySnapshotPath(t)
	err := writeInstanceSnapshot(context.Background(), reg, path)
	if err == nil {
		t.Fatal("a failing liveness probe must fail closed, got nil error")
	}
	discoveryRequireContains(t, "probe-failure error", err.Error(), "docker ps:")
	discoveryRequireAbsent(t, "snapshot written without liveness", path)
}
