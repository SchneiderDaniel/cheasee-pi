package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ui/ Rust project static guards: the container-side bind must be reachable
// through the published DNAT port, the manifest must declare axum, and the
// committed lock must be present for the CI dependency checker. Kept in its
// own file to stay under the repo's per-file line gate.
// ──────────────────────────────────────────────

func uiAsset(t *testing.T, relParts ...string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(append([]string{"embedded", "docker", "ui"}, relParts...)...))
	if err != nil {
		t.Fatalf("read ui asset %v: %v", relParts, err)
	}
	return string(data)
}

func TestUI_MainBindsAllInterfaces(t *testing.T) {
	src := uiAsset(t, "src", "main.rs")
	if !strings.Contains(src, "0.0.0.0") {
		t.Error("ui/src/main.rs must bind all container interfaces (0.0.0.0) — a container-loopback bind is unreachable through the published DNAT port")
	}
	if !strings.Contains(src, "3000") {
		t.Error("ui/src/main.rs must listen on the compose container-side port 3000")
	}
	if strings.Contains(src, "127.0.0.1") {
		t.Error("ui/src/main.rs must not bind 127.0.0.1 — the host reaches the container only through its published port")
	}
}

func TestUI_CargoManifest(t *testing.T) {
	manifest := uiAsset(t, "Cargo.toml")
	if !strings.Contains(manifest, "axum") {
		t.Error("ui/Cargo.toml must declare the axum dependency")
	}
	// The committed lock is what the CI rust adapter (scripts/dependency_existence_check)
	// consumes; a missing lock silently drops the transitive dependency scan.
	lock := uiAsset(t, "Cargo.lock")
	for _, want := range []string{`name = "axum"`, `name = "tokio"`} {
		if !strings.Contains(lock, want) {
			t.Errorf("ui/Cargo.lock must pin %s", want)
		}
	}
	// Single source of truth for the container port: no ui/config.json.
	if _, err := os.Stat(filepath.Join("embedded", "docker", "ui", "config.json")); err == nil {
		t.Error("ui/config.json must not exist — the container port lives once in main.rs + the compose mapping")
	}
}
