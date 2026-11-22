package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 4 (cont.): the file adapter's hard cases
//
// A corrupt record must surface (a silent skip would under-count the instances —
// the reported symptom), a hostile key must never escape the registry directory,
// and concurrent writers must not leave temp residue.
// ──────────────────────────────────────────────

func TestDiscovery_registryListCorruptRecordFailsLoudly(t *testing.T) {
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	discoveryRequireNoErr(t, "Record", reg.Record(discoveryRecord("alice-foo-abc12345")))
	discoveryRequireNoErr(t, "write corrupt record", os.WriteFile(filepath.Join(dir, "broken-00000000.json"), []byte("{not json"), 0o644))

	got, err := reg.List()
	if err == nil {
		t.Fatal("a corrupt record must be an error, never a silent under-count")
	}
	discoveryRequireContains(t, "corrupt-record error", err.Error(), "broken-00000000.json")
	if len(got) != 0 {
		t.Errorf("List = %v, want no partial slice", got)
	}
}

func TestDiscovery_registryRejectsPathTraversal(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "instances")
	reg := newFileInstanceRegistry(dir)

	for _, key := range []string{"../escape", "/abs/escape", "a/../../b", "", "UPPER", "with space"} {
		if err := reg.Record(discoveryRecord(key)); err == nil {
			t.Errorf("Record(key=%q) must be rejected", key)
		}
	}
	for _, name := range directoryNames(t, parent) {
		if name == "escape.json" || name == "escape" {
			t.Errorf("record escaped the registry dir: %s", name)
		}
	}
}

func TestDiscovery_registryPersistedJSONShape(t *testing.T) {
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	rec := discoveryRecord("alice-foo-abc12345")
	discoveryRequireNoErr(t, "Record", reg.Record(rec))

	raw, err := os.ReadFile(filepath.Join(dir, rec.Key+".json"))
	discoveryRequireNoErr(t, "read record", err)
	var doc map[string]any
	discoveryRequireNoErr(t, "persisted record is not JSON", json.Unmarshal(raw, &doc))
	got := make([]string, 0, len(doc))
	for key := range doc {
		got = append(got, key)
	}
	slices.Sort(got)
	if want := []string{"codeflowPort", "key", "label", "startedAt", "uiPort"}; !slices.Equal(got, want) {
		t.Errorf("persisted keys = %v, want exactly %v", got, want)
	}
}

func TestDiscovery_registryRecordCarriesNoHostPath(t *testing.T) {
	// The record is read by every sidecar on the host: labels and ports only.
	root := discoveryStartFixture(t, "https://github.com/alice/foo.git")
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	discoveryRequireNoErr(t, "recordInstance", recordInstance(context.Background(), reg, root))

	raw, err := os.ReadFile(filepath.Join(dir, instanceKey(root)+".json"))
	discoveryRequireNoErr(t, "read record", err)
	for _, leak := range []string{root, filepath.Dir(root)} {
		if strings.Contains(string(raw), leak) {
			t.Errorf("persisted record must not carry the host path %q: %s", leak, raw)
		}
	}
}

func TestDiscovery_registryConcurrentRecords(t *testing.T) {
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)

	var wg sync.WaitGroup
	errs := make([]error, 10)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = reg.Record(discoveryRecord("alice-foo-" + string(rune('a'+i)) + "0000000"))
		}(i)
	}
	wg.Wait()
	for _, err := range errs {
		discoveryRequireNoErr(t, "concurrent Record", err)
	}

	discoveryRequireRecordCount(t, reg, 10)
	if entries := directoryNames(t, dir); len(entries) != 10 {
		t.Errorf("registry dir = %d entries, want 10 with no temp residue", len(entries))
	}
}

func TestDiscovery_instanceRegistryDirSharedAcrossVersions(t *testing.T) {
	cache := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cache)

	dir, err := instanceRegistryDir()
	discoveryRequireNoErr(t, "instanceRegistryDir", err)
	if !filepath.IsAbs(dir) {
		t.Errorf("registry dir %q must be absolute", dir)
	}
	if !strings.HasPrefix(dir, filepath.Join(cache, "cheasee-pi")) {
		t.Errorf("registry dir %q must live under <cache>/cheasee-pi", dir)
	}
	if strings.Contains(dir, cliVersion()) {
		t.Errorf("registry dir %q must not be version-keyed — peers of a different CLI version are still live instances", dir)
	}
	again, err := instanceRegistryDir()
	discoveryRequireNoErr(t, "instanceRegistryDir", err)
	if again != dir {
		t.Errorf("instanceRegistryDir not stable: %q then %q", dir, again)
	}

	snapshot, err := instanceSnapshotPath()
	discoveryRequireNoErr(t, "instanceSnapshotPath", err)
	if !filepath.IsAbs(snapshot) || !strings.HasSuffix(snapshot, ".json") {
		t.Errorf("snapshot path %q must be an absolute .json path", snapshot)
	}
	if filepath.Dir(snapshot) != filepath.Dir(dir) {
		t.Errorf("snapshot %q must live in the same state dir as the registry %q", snapshot, dir)
	}
}
