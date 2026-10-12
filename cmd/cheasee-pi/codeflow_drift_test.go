package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
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
