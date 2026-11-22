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
	"time"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// ──────────────────────────────────────────────
// Phase 4: instance registry port + file adapter
//
// Cross-instance discovery needs one durable, enumerable, path-free record per
// running stack. The CLI owns the registry (it is the only layer with a host
// and docker view); the ui sidecar only ever reads a snapshot of it.
// ──────────────────────────────────────────────

// discoveryRecord is a complete registry record for adapter tests.
func discoveryRecord(key string) InstanceRecord {
	return InstanceRecord{
		Key:          key,
		Label:        "alice-foo (ws1)",
		UIPort:       "9501",
		CodeflowPort: "8471",
		StartedAt:    "2024-01-02T03:04:05Z",
	}
}

func TestDiscovery_registryRecordListRoundTrip(t *testing.T) {
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	want := discoveryRecord("alice-foo-abc12345")

	if err := reg.Record(want); err != nil {
		t.Fatalf("Record: %v", err)
	}
	got, err := reg.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 || got[0] != want {
		t.Fatalf("List = %v, want exactly %+v", got, want)
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
		if err := reg.Record(rec); err != nil {
			t.Fatalf("Record(%s): %v", rec.UIPort, err)
		}
	}
	got, err := reg.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("List = %v, want one entry (overwrite, never append)", got)
	}
	if got[0] != second {
		t.Errorf("List = %+v, want the second write %+v", got[0], second)
	}
}

func TestDiscovery_registryRemove(t *testing.T) {
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	rec := discoveryRecord("alice-foo-abc12345")
	if err := reg.Record(rec); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if err := reg.Remove(rec.Key); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	got, err := reg.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("List = %v, want empty", got)
	}
	if _, err := os.Stat(filepath.Join(dir, rec.Key+".json")); !os.IsNotExist(err) {
		t.Errorf("record file must be gone, stat err = %v", err)
	}

	// Idempotent: an unknown key is a no-op, not an error, and it must not
	// disturb the entries that do exist.
	other := discoveryRecord("bob-bar-def67890")
	if err := reg.Record(other); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if err := reg.Remove("nope-00000000"); err != nil {
		t.Errorf("Remove(unknown) = %v, want nil", err)
	}
	got, err = reg.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 || got[0] != other {
		t.Errorf("List = %v, want %+v", got, other)
	}
}

func TestDiscovery_registryListMissingDir(t *testing.T) {
	reg := newFileInstanceRegistry(filepath.Join(t.TempDir(), "does", "not", "exist"))
	got, err := reg.List()
	if err != nil {
		t.Fatalf("List on a missing directory must not error, got %v", err)
	}
	if len(got) != 0 {
		t.Errorf("List = %v, want empty", got)
	}
}

func TestDiscovery_registryListCorruptRecordFailsLoudly(t *testing.T) {
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	good := discoveryRecord("alice-foo-abc12345")
	if err := reg.Record(good); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken-00000000.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := reg.List()
	if err == nil {
		t.Fatal("a corrupt record must be an error, never a silent under-count")
	}
	if !strings.Contains(err.Error(), "broken-00000000.json") {
		t.Errorf("error must name the corrupt file, got %q", err.Error())
	}
	if len(got) != 0 {
		t.Errorf("List = %v, want no partial slice", got)
	}
}

func TestDiscovery_registryRejectsPathTraversal(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "instances")
	reg := newFileInstanceRegistry(dir)

	for _, key := range []string{"../escape", "/abs/escape", "a/../../b", "", "UPPER", "with space"} {
		rec := discoveryRecord(key)
		if err := reg.Record(rec); err == nil {
			t.Errorf("Record(key=%q) must be rejected", key)
		}
	}
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() == "escape.json" || entry.Name() == "escape" {
			t.Errorf("record escaped the registry dir: %s", entry.Name())
		}
	}
}

func TestDiscovery_registryPersistedJSONShape(t *testing.T) {
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	rec := discoveryRecord("alice-foo-abc12345")
	if err := reg.Record(rec); err != nil {
		t.Fatalf("Record: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, rec.Key+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("persisted record is not JSON: %v", err)
	}
	want := []string{"codeflowPort", "key", "label", "startedAt", "uiPort"}
	got := make([]string, 0, len(doc))
	for key := range doc {
		got = append(got, key)
	}
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Errorf("persisted keys = %v, want exactly %v", got, want)
	}
}

func TestDiscovery_registryRecordLeavesNoTemporaryFiles(t *testing.T) {
	// Parent created on demand; the write is atomic via a temp file that must
	// never be left behind (it would be enumerated as a record).
	dir := filepath.Join(t.TempDir(), "nested", "instances")
	reg := newFileInstanceRegistry(dir)
	rec := discoveryRecord("alice-foo-abc12345")
	if err := reg.Record(rec); err != nil {
		t.Fatalf("Record: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("registry dir must exist: %v", err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if !slices.Equal(names, []string{rec.Key + ".json"}) {
		t.Errorf("registry dir = %v, want exactly [%s]", names, rec.Key+".json")
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
			rec := discoveryRecord("alice-foo-" + string(rune('a'+i)) + "0000000")
			errs[i] = reg.Record(rec)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent Record %d: %v", i, err)
		}
	}

	got, err := reg.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 10 {
		t.Errorf("List = %d records, want 10", len(got))
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 10 {
		t.Errorf("registry dir = %d entries, want 10 with no temp residue", len(entries))
	}
}

func TestDiscovery_instanceRegistryDirSharedAcrossVersions(t *testing.T) {
	cache := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cache)

	dir, err := instanceRegistryDir()
	if err != nil {
		t.Fatalf("instanceRegistryDir: %v", err)
	}
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
	if err != nil {
		t.Fatalf("instanceRegistryDir: %v", err)
	}
	if again != dir {
		t.Errorf("instanceRegistryDir not stable: %q then %q", dir, again)
	}

	snapshot, err := instanceSnapshotPath()
	if err != nil {
		t.Fatalf("instanceSnapshotPath: %v", err)
	}
	if !filepath.IsAbs(snapshot) || !strings.HasSuffix(snapshot, ".json") {
		t.Errorf("snapshot path %q must be an absolute .json path", snapshot)
	}
	if filepath.Dir(snapshot) != filepath.Dir(dir) {
		t.Errorf("snapshot %q must live in the same state dir as the registry %q", snapshot, dir)
	}
}

// ──────────────────────────────────────────────
// Phase 5: registry lifecycle (use case)
// ──────────────────────────────────────────────

func TestDiscovery_recordInstanceWritesDiscoverableRecord(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PI_UI_PORT", "")
	t.Setenv("CODEFLOW_PORT", "")
	stubPortProbe(t, true)

	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/foo.git")
	dir, err := instanceRegistryDir()
	if err != nil {
		t.Fatalf("instanceRegistryDir: %v", err)
	}
	reg := newFileInstanceRegistry(dir)

	if err := recordInstance(context.Background(), reg, root); err != nil {
		t.Fatalf("recordInstance: %v", err)
	}
	got, err := reg.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("List = %v, want one record", got)
	}
	rec := got[0]
	if rec.Key != instanceKey(root) {
		t.Errorf("key = %q, want %q", rec.Key, instanceKey(root))
	}
	uiPortValue, err := uiHostPort(root)
	if err != nil {
		t.Fatalf("uiHostPort: %v", err)
	}
	if rec.UIPort != uiPortValue {
		t.Errorf("uiPort = %q, want the freshly resolved %q", rec.UIPort, uiPortValue)
	}
	if !strings.Contains(rec.Label, repoSlug(root)) {
		t.Errorf("label %q must contain the repo slug %q", rec.Label, repoSlug(root))
	}
	if !strings.Contains(rec.Label, filepath.Base(root)) {
		t.Errorf("label %q must contain the worktree basename %q", rec.Label, filepath.Base(root))
	}
	if strings.Contains(rec.Label, filepath.Dir(root)) {
		t.Errorf("label %q must not leak the host path %q", rec.Label, filepath.Dir(root))
	}
	if _, err := time.Parse(time.RFC3339, rec.StartedAt); err != nil {
		t.Errorf("startedAt %q must be RFC3339: %v", rec.StartedAt, err)
	}
}

func TestDiscovery_recordInstanceKeepsSiblingRecords(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PI_UI_PORT", "")
	t.Setenv("CODEFLOW_PORT", "")
	stubPortProbe(t, true)

	_, roots := discoverySiblings(t, 2, "https://github.com/alice/foo.git")
	dir, err := instanceRegistryDir()
	if err != nil {
		t.Fatalf("instanceRegistryDir: %v", err)
	}
	reg := newFileInstanceRegistry(dir)

	if err := recordInstance(context.Background(), reg, roots[0]); err != nil {
		t.Fatalf("recordInstance(ws1): %v", err)
	}
	first, err := reg.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if err := recordInstance(context.Background(), reg, roots[1]); err != nil {
		t.Fatalf("recordInstance(ws2): %v", err)
	}
	second, err := reg.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(second) != 2 {
		t.Fatalf("List = %d records, want 2 (one per worktree)", len(second))
	}
	kept := false
	for _, rec := range second {
		if rec.Key == first[0].Key && rec == first[0] {
			kept = true
		}
	}
	if !kept {
		t.Errorf("ws1 record %+v missing or changed after ws2 registered: %+v", first[0], second)
	}
}

func TestDiscovery_recordInstanceSurfacesMissingStateDir(t *testing.T) {
	// A regular file where the state dir should be: MkdirAll fails, and a
	// missing record must surface — silently skipping it reproduces the bug.
	cache := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cache)
	blocker := filepath.Join(cache, "cheasee-pi")
	if err := os.WriteFile(blocker, []byte("not a dir"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, root := mkWorkspace(t, `{}`)

	dir, err := instanceRegistryDir()
	if err != nil {
		t.Fatalf("instanceRegistryDir: %v", err)
	}
	err = recordInstance(context.Background(), newFileInstanceRegistry(dir), root)
	if err == nil {
		t.Fatal("an unwritable registry must return an error, never skip silently")
	}
}

// ──────────────────────────────────────────────
// Phase 5 (cont.): registry lifecycle on down
// ──────────────────────────────────────────────

// discoveryDownFixture is one workspace with a registered instance, a stubbed
// docker seam and the cwd inside the workspace.
func discoveryDownFixture(t *testing.T, psOutput string) (root string, reg InstanceRegistry, composeCmd *mockCmd) {
	t.Helper()
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PI_UI_PORT", "")
	t.Setenv("CODEFLOW_PORT", "")
	stubPortProbe(t, true)

	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/repo-a.git")
	dir, err := instanceRegistryDir()
	if err != nil {
		t.Fatalf("instanceRegistryDir: %v", err)
	}
	reg = newFileInstanceRegistry(dir)
	if err := recordInstance(context.Background(), reg, root); err != nil {
		t.Fatalf("recordInstance: %v", err)
	}
	chdir(t, root)
	composeCmd, _ = stubDownFlow(t, psOutput)
	return root, reg, composeCmd
}

func TestDiscovery_runDownERemovesOwnRecord(t *testing.T) {
	root, reg, _ := discoveryDownFixture(t, "cheasee-pi-alice-repo-a\n")
	testutil.CaptureStderr(t, func() {
		if err := runDownE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runDownE: %v", err)
		}
	})
	got, err := reg.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("List = %v, want the stopped instance deregistered", got)
	}
	if _, err := os.Stat(filepath.Join(mustRegistryDir(t), instanceKey(root)+".json")); !os.IsNotExist(err) {
		t.Errorf("record file must be gone after down, stat err = %v", err)
	}
}

func TestDiscovery_runDownEKeepsSiblingRecord(t *testing.T) {
	root, reg, _ := discoveryDownFixture(t, "cheasee-pi-alice-repo-a\n")
	// A sibling workspace's record — down must never deregister it.
	sibling := discoveryRecord("alice-repo-a-ffffffff")
	sibling.Label = "alice-repo-a (ws2)"
	if err := reg.Record(sibling); err != nil {
		t.Fatalf("Record(sibling): %v", err)
	}

	testutil.CaptureStderr(t, func() {
		if err := runDownE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runDownE: %v", err)
		}
	})
	got, err := reg.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 || got[0] != sibling {
		t.Errorf("List = %v, want only the sibling record %+v", got, sibling)
	}
	if _, err := os.Stat(filepath.Join(mustRegistryDir(t), instanceKey(root)+".json")); !os.IsNotExist(err) {
		t.Errorf("own record file must be gone, stat err = %v", err)
	}
}

func TestDiscovery_runDownEFailureKeepsRecord(t *testing.T) {
	_, reg, composeCmd := discoveryDownFixture(t, "cheasee-pi-alice-repo-a\n")
	composeCmd.runFn = func() error { return os.ErrPermission }

	testutil.CaptureStderr(t, func() {
		if err := runDownE(&cobra.Command{}, nil); err == nil {
			t.Fatal("a failed compose down must return an error")
		}
	})
	got, err := reg.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("List = %v, want the record kept — the container may still be running", got)
	}
}

func TestDiscovery_runDownENoRecordStillSucceeds(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/repo-a.git")
	chdir(t, root)
	reg := newFileInstanceRegistry(mustRegistryDir(t))
	sibling := discoveryRecord("alice-repo-a-ffffffff")
	if err := reg.Record(sibling); err != nil {
		t.Fatalf("Record(sibling): %v", err)
	}
	stubDownFlow(t, "")

	testutil.CaptureStderr(t, func() {
		if err := runDownE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runDownE on a workspace with no record: %v", err)
		}
	})
	got, err := reg.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 || got[0] != sibling {
		t.Errorf("List = %v, want the sibling record untouched", got)
	}
}

// mustRegistryDir resolves the registry dir for a test that already pinned
// XDG_CACHE_HOME.
func mustRegistryDir(t *testing.T) string {
	t.Helper()
	dir, err := instanceRegistryDir()
	if err != nil {
		t.Fatalf("instanceRegistryDir: %v", err)
	}
	return dir
}
