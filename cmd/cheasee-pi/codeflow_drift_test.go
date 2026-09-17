package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// Shared fixtures: sidecar inspect JSON + cache-dir assets
// ──────────────────────────────────────────────

// codeflowInspectDoc builds the `docker inspect --format '{{json .}}'`
// document for the codeflow sidecar: the config.json bind mount sourcing
// cacheDir, the given spec stamp label ("" → label-less, the pre-upgrade
// form), the given published host port ("" → no binding) and a running
// state. Tests mutate fields for stale/missing/stopped variants.
func codeflowInspectDoc(cacheDir, specHash, hostPort string) map[string]any {
	labels := map[string]string{"com.cheaseepi.managed": "true"}
	if specHash != "" {
		labels[codeflowSpecLabel] = specHash
	}
	bindings := map[string]any{}
	if hostPort != "" {
		bindings["8470/tcp"] = []map[string]string{{"HostIp": "127.0.0.1", "HostPort": hostPort}}
	}
	return map[string]any{
		"Config": map[string]any{"Labels": labels},
		"HostConfig": map[string]any{
			"PortBindings": bindings,
		},
		"Mounts": []map[string]any{
			{"Type": "bind", "Source": filepath.Join(cacheDir, "codeflow", "config.json"), "Destination": "/opt/codeflow/config.json"},
			{"Type": "bind", "Source": "/some/workspace", "Destination": "/workspaces/main"},
		},
		"State": map[string]any{"Running": true, "StartedAt": "2024-01-01T00:00:00Z"},
	}
}

// mustJSON marshals a sidecar doc for the inspect seam. The docs are built
// from literal strings — marshal cannot fail; panic is the test-side proxy
// for an impossible error.
func mustJSON(doc map[string]any) string {
	b, err := json.Marshal(doc)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// codeflowInspectRunner answers the drift `docker inspect --format '{{json
// .}}'` seam call with the given sidecar JSON (inspectCodeflowSpec uses
// CombinedOutput, so the mock must answer via combinedFn).
func codeflowInspectRunner(out string) runner {
	return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(out), nil }}
}

// stubCodeflowInspect stubs the runCommandContext seam so every docker
// inspect call answers with out/err — the only docker call the warn unit
// tests make.
func stubCodeflowInspect(t *testing.T, out string, err error) {
	t.Helper()
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "inspect") {
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(out), err }}
		}
		return &mockCmd{}
	})
}

// writeCodeflowCacheDir writes the extracted sidecar assets a real
// extraction would produce (codeflow/config.json + docker-compose.yml) under
// dir.
func writeCodeflowCacheDir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "codeflow"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "codeflow", "config.json"), []byte(`{"port": 8470, "host": "0.0.0.0"}`), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("name: cheasee-pi\nservices: {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
}

// ──────────────────────────────────────────────
// Phase 1: codeflowSpecHash domain logic
// ──────────────────────────────────────────────

func TestCodeflowSpecHash_deterministic(t *testing.T) {
	_, root := mkWorkspace(t, `{"docker": {"codeflowPort": "9100"}}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	a, err := codeflowSpecHash(root, cacheDir)
	if err != nil {
		t.Fatalf("codeflowSpecHash: %v", err)
	}
	b, err := codeflowSpecHash(root, cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Errorf("same inputs must hash identically: %s vs %s", a, b)
	}
	if len(a) != 64 {
		t.Errorf("spec hash must be 64 hex chars, got %q (%d)", a, len(a))
	}
}

func TestCodeflowSpecHash_flipsOnInputChange(t *testing.T) {
	_, root := mkWorkspace(t, `{"docker": {"codeflowPort": "9100"}}`)
	setUpReady(t)

	base := t.TempDir()
	writeCodeflowCacheDir(t, base)
	baseHash, err := codeflowSpecHash(root, base)
	if err != nil {
		t.Fatal(err)
	}

	// New cache-dir path (a newer CLI extracts a new version-keyed dir).
	other := t.TempDir()
	writeCodeflowCacheDir(t, other)
	if h, _ := codeflowSpecHash(root, other); h == baseHash {
		t.Error("cache-dir path change must flip the hash")
	}

	// codeflow/config.json bytes.
	cfg := t.TempDir()
	writeCodeflowCacheDir(t, cfg)
	if err := os.WriteFile(filepath.Join(cfg, "codeflow", "config.json"), []byte(`{"port": 8471}`), 0644); err != nil {
		t.Fatal(err)
	}
	if h, _ := codeflowSpecHash(root, cfg); h == baseHash {
		t.Error("config.json content change must flip the hash")
	}

	// docker-compose.yml bytes.
	yml := t.TempDir()
	writeCodeflowCacheDir(t, yml)
	if err := os.WriteFile(filepath.Join(yml, "docker-compose.yml"), []byte("name: other\nservices: {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if h, _ := codeflowSpecHash(root, yml); h == baseHash {
		t.Error("compose-file content change must flip the hash")
	}

	// Explicit port (same cache dir, different settings).
	otherRoot := filepath.Join(t.TempDir(), "ws")
	if err := os.MkdirAll(otherRoot, 0755); err != nil {
		t.Fatal(err)
	}
	testutil.WriteCheaseeSettingsFile(t, otherRoot, `{"docker": {"codeflowPort": "9200"}}`)
	if h, _ := codeflowSpecHash(otherRoot, base); h == baseHash {
		t.Error("explicit-port change must flip the hash")
	}
}

func TestCodeflowSpecHash_explicitPortPrecedence(t *testing.T) {
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	// Settings docker.codeflowPort beats env CODEFLOW_PORT.
	_, root := mkWorkspace(t, `{"docker": {"codeflowPort": "9100"}}`)
	setUpReady(t)
	t.Setenv("CODEFLOW_PORT", "9000")
	withSettings, err := codeflowSpecHash(root, cacheDir)
	if err != nil {
		t.Fatal(err)
	}

	envRoot := filepath.Join(t.TempDir(), "ws")
	if err := os.MkdirAll(envRoot, 0755); err != nil {
		t.Fatal(err)
	}
	testutil.WriteCheaseeSettingsFile(t, envRoot, `{}`)
	t.Setenv("CODEFLOW_PORT", "9000")
	envHash, err := codeflowSpecHash(envRoot, cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	if envHash == withSettings {
		t.Error("settings codeflowPort must beat env in the hash")
	}

	// Both absent → derived sentinel; the port is excluded, so two roots
	// with DIFFERENT derived ports must hash identically (runtime
	// allocation must not read as drift).
	t.Setenv("CODEFLOW_PORT", "")
	rootA := filepath.Join(t.TempDir(), "ws-a")
	rootB := filepath.Join(t.TempDir(), "ws-b")
	if err := os.MkdirAll(rootA, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(rootB, 0755); err != nil {
		t.Fatal(err)
	}
	testutil.WriteCheaseeSettingsFile(t, rootA, `{}`)
	testutil.WriteCheaseeSettingsFile(t, rootB, `{}`)
	ha, err := codeflowSpecHash(rootA, cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	hb, err := codeflowSpecHash(rootB, cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	if ha != hb {
		t.Errorf("derived port must be excluded from the hash (sentinel): %s vs %s", ha, hb)
	}
	if ha == envHash {
		t.Error("derived sentinel must differ from an explicit env port")
	}
}

func TestCodeflowSpecHash_missingFilesNoStamp(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)

	// Neither file extracted → no stamp, no error (pre-extraction fixture).
	spec, err := codeflowSpecHash(root, t.TempDir())
	if err != nil {
		t.Fatalf("missing files must not error, got %v", err)
	}
	if spec != "" {
		t.Errorf("missing files must yield no stamp, got %q", spec)
	}

	// Only config.json missing (compose file present) → same.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	spec, err = codeflowSpecHash(root, dir)
	if err != nil || spec != "" {
		t.Errorf("missing config.json with compose present must give no stamp / no error, got (%q, %v)", spec, err)
	}
}

func TestCodeflowSpecHash_readErrorSurfaces(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	dir := t.TempDir()
	// ENOTDIR: config.json's parent is a regular file — not IsNotExist, so
	// the error must surface (a silent no-stamp would hide the failure).
	if err := os.WriteFile(filepath.Join(dir, "codeflow"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := codeflowSpecHash(root, dir); err == nil {
		t.Fatal("non-NotExist read error must surface")
	}
}

// ──────────────────────────────────────────────
// Phase 2: inspectCodeflowSpec parsing
// ──────────────────────────────────────────────

func TestInspectCodeflowSpec_parsesLiveJSON(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ws")
	cacheDir := t.TempDir()
	doc := codeflowInspectDoc(cacheDir, "abc123", "9000")

	var gotArgs []string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" {
			gotArgs = append([]string(nil), arg...)
			return codeflowInspectRunner(mustJSON(doc))
		}
		return &mockCmd{}
	})

	spec, err := inspectCodeflowSpec(context.Background(), root)
	if err != nil {
		t.Fatalf("inspectCodeflowSpec: %v", err)
	}
	if !slices.Contains(gotArgs, codeflowContainerName(root)) {
		t.Errorf("inspect must target the derived sidecar container %s, got %v", codeflowContainerName(root), gotArgs)
	}
	if spec.Missing {
		t.Error("existing container must not read as missing")
	}
	if spec.Config.Labels[codeflowSpecLabel] != "abc123" {
		t.Errorf("label parse: got %q, want abc123", spec.Config.Labels[codeflowSpecLabel])
	}
	if got, _ := codeflowConfigMountSource(spec); got != filepath.Join(cacheDir, "codeflow", "config.json") {
		t.Errorf("mount source parse: got %q", got)
	}
	if got := codeflowBoundHostPort(spec); got != "9000" {
		t.Errorf("bound host port parse: got %q, want 9000", got)
	}
	if !spec.State.Running {
		t.Error("State.Running must parse as true")
	}
}

func TestInspectCodeflowSpec_failureWraps(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ws")
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" {
			return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon gone") }}
		}
		return &mockCmd{}
	})
	_, err := inspectCodeflowSpec(context.Background(), root)
	if err == nil || !strings.Contains(err.Error(), "docker inspect") {
		t.Fatalf("inspect failure must wrap as 'docker inspect: ...', got %v", err)
	}
}

func TestInspectCodeflowSpec_noSuchObjectIsMissing(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ws")
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" {
			return &mockCmd{combinedFn: func() ([]byte, error) {
				return []byte("Error: No such object: codeflow-ws"), exitStatusError(1)
			}}
		}
		return &mockCmd{}
	})
	spec, err := inspectCodeflowSpec(context.Background(), root)
	if err != nil {
		t.Fatalf("missing sidecar must be a condition, not a failure: %v", err)
	}
	if !spec.Missing {
		t.Error("'No such object' must read as the missing drift condition")
	}
}

func TestInspectCodeflowSpec_malformedJSONErrors(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ws")
	stubCodeflowInspect(t, "{not json", nil)
	_, err := inspectCodeflowSpec(context.Background(), root)
	if err == nil || !strings.Contains(err.Error(), "parse docker inspect") {
		t.Fatalf("malformed JSON must wrap as 'parse docker inspect: ...', got %v", err)
	}
}

// ──────────────────────────────────────────────
// Phase 3: warnIfCodeflowDrift compare + messaging
// ──────────────────────────────────────────────

// assertCodeflowRecoveryCommands asserts stderr carries the exact recovery
// command pair every stale warning must print.
func assertCodeflowRecoveryCommands(t *testing.T, stderr string) {
	t.Helper()
	for _, want := range []string{"cheasee-pi start --build", "cheasee-pi down", "cheasee-pi start"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("warning must print the exact recovery command %q, got: %q", want, stderr)
		}
	}
}

func TestWarnIfCodeflowDrift_currentSpecSilent(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)
	spec, err := codeflowSpecHash(root, cacheDir)
	if err != nil {
		t.Fatal(err)
	}

	stubCodeflowInspect(t, mustJSON(codeflowInspectDoc(cacheDir, spec, "")), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if stderr != "" {
		t.Errorf("matching sidecar must warn nothing, got: %q", stderr)
	}
}

func TestWarnIfCodeflowDrift_staleConfigMountWarns(t *testing.T) {
	// Newer CLI extracted a new cache dir; the running sidecar still mounts
	// the old one (old stamp rides along).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	oldCache := filepath.Join(t.TempDir(), "cheasee-pi", "0.54.0")
	writeCodeflowCacheDir(t, oldCache)
	oldSpec, _ := codeflowSpecHash(root, oldCache)

	stubCodeflowInspect(t, mustJSON(codeflowInspectDoc(oldCache, oldSpec, "")), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "stale") {
		t.Errorf("warning must say the sidecar is stale, got: %q", stderr)
	}
	if !strings.Contains(stderr, "config.json") {
		t.Errorf("warning must name the drifted config.json mount, got: %q", stderr)
	}
	if !strings.Contains(stderr, "cheasee-pi start --build") || !strings.Contains(stderr, "cheasee-pi down") {
		t.Errorf("warning must print BOTH recovery commands, got: %q", stderr)
	}
}

func TestWarnIfCodeflowDrift_portChangedWarns(t *testing.T) {
	// Settings now pin 9100; the live sidecar still publishes 9000.
	_, root := mkWorkspace(t, `{"docker": {"codeflowPort": "9100"}}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)
	spec, _ := codeflowSpecHash(root, cacheDir)

	stubCodeflowInspect(t, mustJSON(codeflowInspectDoc(cacheDir, spec, "9000")), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "9000") || !strings.Contains(stderr, "9100") {
		t.Errorf("port drift warning must name live (9000) and expected (9100) ports, got: %q", stderr)
	}
	if !strings.Contains(stderr, "host port") {
		t.Errorf("warning must name the mapped port, got: %q", stderr)
	}
	assertCodeflowRecoveryCommands(t, stderr)
}

func TestWarnIfCodeflowDrift_settingsPortBeatsEnv(t *testing.T) {
	// Settings 9100 + env 9000: the check must follow settings, so a live
	// bind of the settings port with a matching stamp stays silent.
	_, root := mkWorkspace(t, `{"docker": {"codeflowPort": "9100"}}`)
	setUpReady(t)
	t.Setenv("CODEFLOW_PORT", "9000")
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)
	spec, _ := codeflowSpecHash(root, cacheDir)

	stubCodeflowInspect(t, mustJSON(codeflowInspectDoc(cacheDir, spec, "9100")), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if stderr != "" {
		t.Errorf("settings port must beat env in the drift check, got: %q", stderr)
	}
}

func TestWarnIfCodeflowDrift_derivedPortIgnored(t *testing.T) {
	// No settings/env port: the live published port is runtime allocation —
	// a different bind must NOT warn (probe occupancy shifts with no config
	// change).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)
	spec, _ := codeflowSpecHash(root, cacheDir)

	stubCodeflowInspect(t, mustJSON(codeflowInspectDoc(cacheDir, spec, "9999")), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if stderr != "" {
		t.Errorf("derived-port allocation shift must not warn, got: %q", stderr)
	}
}

func TestWarnIfCodeflowDrift_hashMismatchWarns(t *testing.T) {
	// Same cache dir + same mount + derived port: only the composite stamp
	// can catch a same-path config.json content edit.
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	stubCodeflowInspect(t, mustJSON(codeflowInspectDoc(cacheDir, strings.Repeat("f", 64), "")), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "stamp") {
		t.Errorf("stamp mismatch must warn naming the stamp, got: %q", stderr)
	}
	assertCodeflowRecoveryCommands(t, stderr)
}

func TestWarnIfCodeflowDrift_noLabelOldContainerSilent(t *testing.T) {
	// Pre-upgrade sidecar without the spec label: no hash warning, and with
	// all fields matching (mount + derived port) nothing prints.
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	stubCodeflowInspect(t, mustJSON(codeflowInspectDoc(cacheDir, "", "")), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if stderr != "" {
		t.Errorf("label-less sidecar with matching fields must be silent, got: %q", stderr)
	}
}

func TestWarnIfCodeflowDrift_missingSidecarWarns(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	stubCodeflowInspect(t, "Error: No such object: codeflow-ws", exitStatusError(1))
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "does not exist") {
		t.Errorf("missing sidecar must warn naming the missing state, got: %q", stderr)
	}
	assertCodeflowRecoveryCommands(t, stderr)
}

func TestWarnIfCodeflowDrift_stoppedSidecarWarns(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	doc := codeflowInspectDoc(cacheDir, "", "")
	doc["State"] = map[string]any{"Running": false, "StartedAt": "2024-01-01T00:00:00Z"}
	stubCodeflowInspect(t, mustJSON(doc), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "stopped") {
		t.Errorf("stopped sidecar must warn naming the stopped state, got: %q", stderr)
	}
	assertCodeflowRecoveryCommands(t, stderr)
}

func TestWarnIfCodeflowDrift_inspectFailureWarnsNonFatal(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	stubCodeflowInspect(t, "", fmt.Errorf("daemon gone"))
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "could not verify") {
		t.Errorf("inspect failure must warn 'could not verify', got: %q", stderr)
	}
	assertCodeflowRecoveryCommands(t, stderr)
}

func TestWarnIfCodeflowDrift_badJSONWarnsNonFatal(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	stubCodeflowInspect(t, "{not json", nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "could not verify") {
		t.Errorf("bad inspect JSON must warn 'could not verify', got: %q", stderr)
	}
}

func TestWarnIfCodeflowDrift_hashErrorWarnsNonFatal(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	// `codeflow` is a regular file → reading codeflow/config.json hits
	// ENOTDIR: the check cannot compute the expected state.
	if err := os.WriteFile(filepath.Join(cacheDir, "codeflow"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "could not compute") {
		t.Errorf("hash failure must warn 'could not compute the expected configuration', got: %q", stderr)
	}
	assertCodeflowRecoveryCommands(t, stderr)
}

// ──────────────────────────────────────────────
// Phase 5: stamp env injection (stamp-vs-compare consistency)
// ──────────────────────────────────────────────

func TestApplyComposeEnv_injectsCodeflowSpecStamp(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	composeDir := t.TempDir()
	writeCodeflowCacheDir(t, composeDir)
	spec, err := codeflowSpecHash(root, composeDir)
	if err != nil {
		t.Fatal(err)
	}

	cmd := &mockCmd{}
	applyComposeEnv(cmd, root, containerName(root), composeDir)

	var hits []string
	for _, e := range cmd.env {
		if k, v, ok := strings.Cut(e, "="); ok && k == codeflowSpecEnv {
			hits = append(hits, v)
		}
	}
	if len(hits) != 1 || hits[0] != spec {
		t.Errorf("exactly one %s=<hash> entry expected (stamp-vs-compare consistency), got %v (want %s)", codeflowSpecEnv, hits, spec)
	}
}

func TestApplyComposeEnv_inheritedSpecStampReplaced(t *testing.T) {
	// An inherited CHEASEEPI_CODEFLOW_SPEC must be stripped and replaced —
	// a stale inherited stamp would otherwise mislabel a fresh container.
	t.Setenv("CHEASEEPI_CODEFLOW_SPEC", "11223344556677889900aabbccddeeff")
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	composeDir := t.TempDir()
	writeCodeflowCacheDir(t, composeDir)
	spec, err := codeflowSpecHash(root, composeDir)
	if err != nil {
		t.Fatal(err)
	}

	cmd := &mockCmd{}
	applyComposeEnv(cmd, root, containerName(root), composeDir)

	var hits []string
	for _, e := range cmd.env {
		if k, v, ok := strings.Cut(e, "="); ok && k == codeflowSpecEnv {
			hits = append(hits, v)
		}
	}
	if len(hits) != 1 || hits[0] != spec {
		t.Errorf("inherited stamp must be replaced by exactly one fresh entry, got %v (want %s)", hits, spec)
	}
}