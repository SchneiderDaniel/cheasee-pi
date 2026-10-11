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

// ──────────────────────────────────────────────
// Slice 2: hydrate shell + WS echo structural guards
// ──────────────────────────────────────────────

// TestUI_FileLayout pins the lib/bin/src split cargo-leptos needs. Deleting a
// module silently drops a route or the hydration entry; the layout is contract.

func TestUI_FileLayout(t *testing.T) {
	for _, rel := range [][]string{
		{"src", "lib.rs"},
		{"src", "app.rs"},
		{"src", "ws.rs"},
		{"src", "bridge.rs"},
		{"src", "protocol.rs"},
		{"src", "retry.rs"},
		{"src", "stream.rs"},
		{"src", "bash.rs"},
		{"src", "tool_card.rs"},
		{"src", "controls.rs"},
		{"src", "components", "mod.rs"},
		{"src", "components", "message.rs"},
		{"src", "components", "controls.rs"},
		{"src", "components", "banners.rs"},
		{"src", "components", "tool_card.rs"},
		{"src", "components", "bash.rs"},
		{"src", "components", "queue.rs"},
		{"src", "components", "session_list.rs"},
		{"src", "auth.rs"},
		{"src", "pi_process.rs"},
		{"src", "rpc", "mod.rs"},
		{"src", "rpc", "framing.rs"},
		{"src", "rpc", "client.rs"},
		{"src", "session.rs"},
		{"src", "sessions_store.rs"},
		{"tests", "rpc_protocol.rs"},
		{"tests", "stream_assembly.rs"},
		{"tests", "event_widgets.rs"},
		{"tests", "session_controls.rs"},
		{"tests", "fixtures", "PI_VERSION"},
		{"tests", "fixtures", "commands.jsonl"},
		{"tests", "fixtures", "responses.jsonl"},
		{"tests", "fixtures", "events.jsonl"},
		{"tests", "fixtures", "extension_ui.jsonl"},
		{"provider_env_map.json"},
		{"style", "main.css"},
	} {
		path := filepath.Join(append([]string{"embedded", "docker", "ui"}, rel...)...)
		if _, err := os.Stat(path); err != nil {
			t.Errorf("ui asset %v missing: %v", rel, err)
		}
	}
}

// TestUI_ShellHydrationContract guards the bootstrap that makes AC1 survive: a
// 200 with valid-looking HTML proves nothing unless HydrationScripts and the
// hashed stylesheet are actually emitted, and hydration only succeeds when the
// SSR and client render trees agree (no clock/randomness/browser APIs).

func TestUI_ShellHydrationContract(t *testing.T) {
	lib := uiAsset(t, "src", "lib.rs")
	for _, want := range []string{
		"pub fn shell(options: LeptosOptions)",
		"HydrationScripts",
		"HashedStylesheet",
		"pub fn hydrate()",
		"wasm_bindgen",
	} {
		if !strings.Contains(lib, want) {
			t.Errorf("ui/src/lib.rs must contain %q", want)
		}
	}

	app := uiAsset(t, "src", "app.rs")
	// provide_meta_context installs the MetaContext the meta components read;
	// without it the shell renders and never hydrates.
	if !strings.Contains(app, "provide_meta_context") || !strings.Contains(app, "MetaContext") {
		t.Error("ui/src/app.rs must provide the MetaContext (provide_meta_context)")
	}

	// Render parity: SSR and hydrate must produce identical trees, so the render
	// path must not read wall-clock time, randomness, or browser-only globals.
	for _, src := range []struct{ name, body string }{{"lib.rs", lib}, {"app.rs", app}} {
		for _, forbidden := range []string{"SystemTime::now", "rand::", "web_sys::window()"} {
			if strings.Contains(src.body, forbidden) {
				t.Errorf("render path ui/src/%s must not use %s (SSR/hydrate mismatch)", src.name, forbidden)
			}
		}
	}
}

// TestUI_RoutesAndBind guards the four endpoints AC1/AC2/AC3/AC4 need and the
// all-interfaces bind the published DNAT port requires. axum 0.8 rejects the
// legacy `:param` / `*rest` path syntax at router construction, so guard against
// reintroducing it.

func TestUI_RoutesAndBind(t *testing.T) {
	src := uiAsset(t, "src", "main.rs")
	for _, want := range []string{
		`"/"`,
		`"/health"`,
		`"/ws"`,
		`"/assets"`,
		`"0.0.0.0"`,
		"3000",
		"immutable",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("ui/src/main.rs must contain %q", want)
		}
	}
	if strings.Contains(src, "127.0.0.1") {
		t.Error("ui/src/main.rs must not contain 127.0.0.1 — the container binds all interfaces")
	}
	for _, legacy := range []string{"\"/:", "\"/*"} {
		if strings.Contains(src, legacy) {
			t.Errorf("ui/src/main.rs must not use the legacy axum path syntax %s", legacy)
		}
	}
}

// TestUI_CargoFeatures guards the two-target feature split cargo-leptos drives
// (empty default + hydrate/ssr) and keeps client-side randomness out of the wasm
// bundle — getrandom needs a JS-backed source, which slice 4 must design for.
