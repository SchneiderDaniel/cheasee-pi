package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 4: instance registry port + file adapter
//
// Cross-instance discovery needs one durable, enumerable, path-free record per
// running stack. The CLI owns the registry (it is the only layer with a host
// and docker view); the ui sidecar only ever reads a snapshot of it.
// ──────────────────────────────────────────────

func TestDiscovery_registryRecordListRoundTrip(t *testing.T) {
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	want := discoveryRecord("alice-foo-abc12345")

	discoveryRequireNoErr(t, "Record", reg.Record(want))
	got := discoveryRequireRecordCount(t, reg, 1)
	if got[0] != want {
		t.Fatalf("List = %+v, want exactly %+v", got[0], want)
	}
	if _, err := os.Stat(filepath.Join(dir, want.Key+".json")); err != nil {
		t.Errorf("record file must live at <dir>/<key>.json: %v", err)
	}
}

func TestDiscovery_registryRecordOverwritesKey(t *testing.T) {
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	first := discoveryRecord("alice-foo-abc12345")
	second := first
	second.UIPort = "9999"

	for _, rec := range []InstanceRecord{first, second} {
		discoveryRequireNoErr(t, "Record", reg.Record(rec))
	}
	got := discoveryRequireRecordCount(t, reg, 1)
	if got[0] != second {
		t.Errorf("List = %+v, want the second write %+v (overwrite, never append)", got[0], second)
	}
}

func TestDiscovery_registryRemove(t *testing.T) {
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	rec := discoveryRecord("alice-foo-abc12345")
	discoveryRequireNoErr(t, "Record", reg.Record(rec))

	discoveryRequireNoErr(t, "Remove", reg.Remove(rec.Key))
	discoveryRequireRecordCount(t, reg, 0)
	discoveryRequireAbsent(t, "record file", filepath.Join(dir, rec.Key+".json"))

	// Idempotent: an unknown key is a no-op, not an error, and it must not
	// disturb the entries that do exist.
	other := discoveryRecord("bob-bar-def67890")
	discoveryRequireNoErr(t, "Record", reg.Record(other))
	discoveryRequireNoErr(t, "Remove(unknown)", reg.Remove("nope-00000000"))
	if got := discoveryRequireRecordCount(t, reg, 1); got[0] != other {
		t.Errorf("List = %+v, want %+v", got[0], other)
	}
}

func TestDiscovery_registryListMissingDir(t *testing.T) {
	reg := newFileInstanceRegistry(filepath.Join(t.TempDir(), "does", "not", "exist"))
	discoveryRequireRecordCount(t, reg, 0)
}

func TestDiscovery_registryRecordLeavesNoTemporaryFiles(t *testing.T) {
	// Parent created on demand; the write is atomic via a temp file that must
	// never be left behind (it would be enumerated as a record).
	dir := filepath.Join(t.TempDir(), "nested", "instances")
	reg := newFileInstanceRegistry(dir)
	rec := discoveryRecord("alice-foo-abc12345")
	discoveryRequireNoErr(t, "Record", reg.Record(rec))

	names := directoryNames(t, dir)
	if !slices.Equal(names, []string{rec.Key + ".json"}) {
		t.Errorf("registry dir = %v, want exactly [%s]", names, rec.Key+".json")
	}
}

// directoryNames lists a directory's entry names in readdir order.
func directoryNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	discoveryRequireNoErr(t, "registry dir must exist", err)
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}
