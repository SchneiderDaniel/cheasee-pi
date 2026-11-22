package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 6: read-only instance snapshot + compose mount
//
// The ui sidecar is not allowed a host or docker view (docs/security.md), so
// discovery is served by one CLI-written snapshot file bind-mounted read-only
// into the `ui` service. Liveness is resolved at write time from `docker ps
// -a`, never trusted from the registry file (a host crash leaves stale
// records).
// ──────────────────────────────────────────────

// stubSnapshotStates answers the container-state probe with the exact
// `{{.Names}}|{{.State}}` lines the snapshot builder parses.
func stubSnapshotStates(t *testing.T, lines string, probeErr error) {
	t.Helper()
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "ps") {
			if probeErr != nil {
				err := probeErr
				return &mockCmd{outputFn: func() ([]byte, error) { return nil, err }}
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(lines), nil }}
		}
		return &mockCmd{}
	})
}

// discoverySnapshotPath is a temp-dir snapshot target.
func discoverySnapshotPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "instances.json")
}

// readSnapshot decodes the snapshot file into raw entries.
func readSnapshot(t *testing.T, path string) []map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	var doc []map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("snapshot is not JSON (%s): %v", raw, err)
	}
	return doc
}

func TestDiscovery_snapshotListsRunningInstances(t *testing.T) {
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	zeta := discoveryRecord("alice-foo-ffffffff")
	zeta.Label = "alice-foo (ws2)"
	alpha := discoveryRecord("alice-foo-00000000")
	alpha.Label = "alice-foo (ws1)"
	// Recorded out of key order on purpose: the snapshot orders by key.
	for _, rec := range []InstanceRecord{zeta, alpha} {
		if err := reg.Record(rec); err != nil {
			t.Fatalf("Record: %v", err)
		}
	}
	stubSnapshotStates(t, containerNameFromKey(alpha.Key)+"|running\n"+containerNameFromKey(zeta.Key)+"|running\n", nil)

	path := discoverySnapshotPath(t)
	if err := writeInstanceSnapshot(context.Background(), reg, path); err != nil {
		t.Fatalf("writeInstanceSnapshot: %v", err)
	}
	doc := readSnapshot(t, path)
	if len(doc) != 2 {
		t.Fatalf("snapshot = %v, want two entries", doc)
	}
	if doc[0]["key"] != alpha.Key || doc[1]["key"] != zeta.Key {
		t.Errorf("snapshot order = %v, %v — want key order", doc[0]["key"], doc[1]["key"])
	}
	wantKeys := []string{"key", "label", "running", "uiPort"}
	for _, entry := range doc {
		keys := make([]string, 0, len(entry))
		for key := range entry {
			keys = append(keys, key)
		}
		slices.Sort(keys)
		if !slices.Equal(keys, wantKeys) {
			t.Errorf("entry keys = %v, want exactly %v", keys, wantKeys)
		}
		if entry["running"] != true {
			t.Errorf("entry %v must be running", entry["key"])
		}
		if entry["uiPort"] == "" || entry["uiPort"] == nil {
			t.Errorf("entry %v must carry the ui port", entry["key"])
		}
	}
}

func TestDiscovery_snapshotOmitsStaleRecords(t *testing.T) {
	// A record whose container is gone is a stale record (host crash, manual
	// rm): it must not surface as an available instance.
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	live := discoveryRecord("alice-foo-00000000")
	gone := discoveryRecord("alice-foo-ffffffff")
	for _, rec := range []InstanceRecord{live, gone} {
		if err := reg.Record(rec); err != nil {
			t.Fatalf("Record: %v", err)
		}
	}
	stubSnapshotStates(t, containerNameFromKey(live.Key)+"|running\n", nil)

	path := discoverySnapshotPath(t)
	if err := writeInstanceSnapshot(context.Background(), reg, path); err != nil {
		t.Fatalf("writeInstanceSnapshot: %v", err)
	}
	doc := readSnapshot(t, path)
	if len(doc) != 1 || doc[0]["key"] != live.Key {
		t.Fatalf("snapshot = %v, want only the live instance %q", doc, live.Key)
	}
}

func TestDiscovery_snapshotReportsStoppedContainer(t *testing.T) {
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	rec := discoveryRecord("alice-foo-00000000")
	if err := reg.Record(rec); err != nil {
		t.Fatalf("Record: %v", err)
	}
	stubSnapshotStates(t, containerNameFromKey(rec.Key)+"|exited\n", nil)

	path := discoverySnapshotPath(t)
	if err := writeInstanceSnapshot(context.Background(), reg, path); err != nil {
		t.Fatalf("writeInstanceSnapshot: %v", err)
	}
	doc := readSnapshot(t, path)
	if len(doc) != 1 {
		t.Fatalf("snapshot = %v, want one entry", doc)
	}
	if doc[0]["running"] != false {
		t.Errorf("an exited container must be listed as not running, got %v", doc[0])
	}
}

func TestDiscovery_snapshotIsDeterministicAndPathFree(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PI_UI_PORT", "")
	t.Setenv("CODEFLOW_PORT", "")
	stubPortProbe(t, true)

	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/foo.git")
	reg := newFileInstanceRegistry(mustRegistryDir(t))
	if err := recordInstance(context.Background(), reg, root); err != nil {
		t.Fatalf("recordInstance: %v", err)
	}
	stubSnapshotStates(t, containerName(root)+"|running\n", nil)

	path := discoverySnapshotPath(t)
	if err := writeInstanceSnapshot(context.Background(), reg, path); err != nil {
		t.Fatalf("writeInstanceSnapshot: %v", err)
	}
	first, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeInstanceSnapshot(context.Background(), reg, path); err != nil {
		t.Fatalf("writeInstanceSnapshot (second): %v", err)
	}
	second, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Errorf("snapshot must be byte-identical across writes:\n%s\n%s", first, second)
	}
	for _, leak := range []string{root, parent, filepath.Dir(root)} {
		if strings.Contains(string(first), leak) {
			t.Errorf("snapshot must not contain the host path %q: %s", leak, first)
		}
	}
}

func TestDiscovery_ensureSnapshotFallsBackToEmptyOnCorruptRegistry(t *testing.T) {
	// A corrupt peer record must not block a start, and the ui service's mount
	// target must still exist as a FILE (docker would otherwise create a
	// directory there). The fault is reported, never swallowed.
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	dir := mustRegistryDir(t)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken-00000000.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	path, err := instanceSnapshotPath()
	if err != nil {
		t.Fatalf("instanceSnapshotPath: %v", err)
	}

	err = ensureInstanceSnapshot(context.Background())
	if err == nil {
		t.Fatal("a corrupt registry must be reported, got nil error")
	}
	if !strings.Contains(err.Error(), "broken-00000000.json") {
		t.Errorf("error must name the corrupt record, got %q", err.Error())
	}
	raw, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("mount target must exist after a failed snapshot: %v", readErr)
	}
	if got := strings.TrimSpace(string(raw)); got != "[]" {
		t.Errorf("fallback snapshot = %q, want an empty list", got)
	}
	// Idempotent: an existing snapshot is left alone (the content is refreshed
	// after the stack is up).
	if err := ensureInstanceSnapshot(context.Background()); err != nil {
		t.Errorf("an existing snapshot must satisfy the pre-compose step, got %v", err)
	}
}

func TestDiscovery_snapshotProbeFailureWritesNothing(t *testing.T) {
	dir := t.TempDir()
	reg := newFileInstanceRegistry(dir)
	if err := reg.Record(discoveryRecord("alice-foo-00000000")); err != nil {
		t.Fatalf("Record: %v", err)
	}
	stubSnapshotStates(t, "", errors.New("daemon gone"))

	path := discoverySnapshotPath(t)
	err := writeInstanceSnapshot(context.Background(), reg, path)
	if err == nil {
		t.Fatal("a failing liveness probe must fail closed, got nil error")
	}
	if !strings.Contains(err.Error(), "docker ps:") && !strings.Contains(err.Error(), "docker inspect:") {
		t.Errorf("error must wrap the probe failure, got %q", err.Error())
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Errorf("no snapshot may be written when liveness is unknown, stat err = %v", statErr)
	}
}

// ──────────────────────────────────────────────
// Static: compose wiring
// ──────────────────────────────────────────────

// snapshotMount returns the ui service's registry mount spec.
func snapshotMount(t *testing.T, content map[string]any) string {
	t.Helper()
	vols, ok := content["volumes"].([]any)
	if !ok {
		t.Fatalf("ui volumes missing, got %v", content["volumes"])
	}
	for _, vol := range vols {
		spec, _ := vol.(string)
		if strings.Contains(spec, "CHEASEEPI_INSTANCE_SNAPSHOT") {
			return spec
		}
	}
	t.Fatalf("ui volumes must carry the instance snapshot mount, got %v", vols)
	return ""
}

func TestDiscovery_composeUIMountsReadOnlySnapshot(t *testing.T) {
	ui := composeService(t, readCompose(t), "ui")
	spec := snapshotMount(t, ui)
	if !strings.HasSuffix(spec, ":ro") {
		t.Errorf("snapshot mount %q must be read-only", spec)
	}
	source, _, _ := strings.Cut(spec, ":")
	if !strings.HasPrefix(source, "${CHEASEEPI_INSTANCE_SNAPSHOT") {
		t.Errorf("snapshot mount source = %q, want the CLI-resolved ${CHEASEEPI_INSTANCE_SNAPSHOT…} path", source)
	}
	vols := ui["volumes"].([]any)
	registryMounts := 0
	for _, vol := range vols {
		if spec, _ := vol.(string); strings.Contains(spec, "CHEASEEPI_INSTANCE_SNAPSHOT") {
			registryMounts++
		}
	}
	if registryMounts != 1 {
		t.Errorf("ui must carry exactly one snapshot mount, got %d (%v)", registryMounts, vols)
	}
}

func TestDiscovery_composeOnlyUISeestheSnapshot(t *testing.T) {
	content := readCompose(t)
	for _, service := range []string{"cheasee-pi", "codeflow"} {
		svc := composeService(t, content, service)
		vols, ok := svc["volumes"].([]any)
		if !ok {
			continue
		}
		for _, vol := range vols {
			if spec, _ := vol.(string); strings.Contains(spec, "CHEASEEPI_INSTANCE_SNAPSHOT") {
				t.Errorf("service %s must not mount the instance snapshot, got %v", service, spec)
			}
		}
	}
}

func TestDiscovery_composeSnapshotMountStaysUnprivileged(t *testing.T) {
	content := readCompose(t)
	ui := composeService(t, content, "ui")
	spec := snapshotMount(t, ui)
	if strings.Contains(spec, "docker.sock") {
		t.Errorf("snapshot mount %q must not reach the docker socket", spec)
	}
	if strings.Contains(spec, "WORKSPACE_HOST_PATH") {
		t.Errorf("snapshot mount %q must not be workspace-scoped — peer discovery is host-wide", spec)
	}
	if strings.Contains(content, "/var/run/docker.sock") {
		t.Error("compose must never mount the docker socket (docs/security.md)")
	}
}

func TestDiscovery_applyComposeEnvCarriesSnapshotPath(t *testing.T) {
	cache := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cache)
	t.Setenv("PI_UI_PORT", "")
	t.Setenv("CODEFLOW_PORT", "")
	stubPortProbe(t, true)
	_, root := mkWorkspace(t, `{}`)

	want, err := instanceSnapshotPath()
	if err != nil {
		t.Fatalf("instanceSnapshotPath: %v", err)
	}

	// No published snapshot yet → the env var stays unset so compose uses its
	// `:-` default instead of binding a path that does not exist.
	cmd := &mockCmd{}
	applyComposeEnv(cmd, root, containerName(root), t.TempDir())
	if got := composeEnvValue(cmd.env, instanceSnapshotEnv); got != "" {
		t.Errorf("%s = %q, want unset before the CLI published a snapshot", instanceSnapshotEnv, got)
	}

	if err := os.MkdirAll(filepath.Dir(want), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(want, []byte("[]\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cmd = &mockCmd{}
	applyComposeEnv(cmd, root, containerName(root), t.TempDir())
	got := composeEnvValue(cmd.env, instanceSnapshotEnv)
	if got != want {
		t.Errorf("%s = %q, want %q", instanceSnapshotEnv, got, want)
	}
	if !filepath.IsAbs(got) || !strings.HasSuffix(got, ".json") {
		t.Errorf("snapshot env %q must be an absolute .json path", got)
	}
	if strings.Contains(got, root) {
		t.Errorf("snapshot env %q must not be workspace-scoped", got)
	}
}
