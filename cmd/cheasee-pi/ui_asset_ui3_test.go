package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUI_SBOMDocumentsStack(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "sbom.md"))
	if err != nil {
		t.Fatalf("read docs/sbom.md: %v", err)
	}
	sbom := string(data)
	for _, want := range []string{"leptos", "leptos_axum", "cargo-leptos"} {
		if !strings.Contains(sbom, want) {
			t.Errorf("docs/sbom.md must list %q", want)
		}
	}
}

// TestUI_WSClientLifecycleWiring pins the lifecycle defects a prior audit
// caught: a send that silently no-ops (or discards its error), a retry counter
// reset on open, a stability timer armed before the socket ever opened, and a
// reconnect lifecycle whose wiring only a browser could exercise. The behavior
// lives in `retry.rs`, where one `wire` function installs the socket callbacks
// for *both* the wasm shell and the host tests (which fire a fake socket and
// clock). This keeps that wiring from being deleted where the wasm build
// compiles it, since the Go gate cannot run Rust.

func TestUI_WSClientLifecycleWiring(t *testing.T) {
	retry := uiAsset(t, "src", "retry.rs")
	for _, want := range []string{
		"pub struct Reconnect",
		"pub enum SendOutcome",
		"pub fn deliver",
		"on_stable",
		// Injectable lifecycle: the stability timer is an event a host test can
		// fire, so open/close/reconnect are assertable without a browser.
		"pub struct Session",
		"pub enum SessionEffect",
		"pub fn stable_elapsed",
		"pub fn send_status",
		"pub struct Adapter",
		"pub struct StabilityTimer",
		// The single callback-to-adapter wiring: `ws.rs` and the lifecycle tests
		// both install *this* function, so the test fires the real closures.
		"pub trait Socket",
		"pub trait Timer",
		"pub fn wire",
	} {
		if !strings.Contains(retry, want) {
			t.Errorf("ui/src/retry.rs must contain %q (reconnect/send/wiring policy)", want)
		}
	}

	ws := uiAsset(t, "src", "ws.rs")
	for _, want := range []string{
		// The wasm shell installs the shared wiring and implements the two
		// seams (`Socket`, `Timer`) it abstracts over.
		"wire(",
		"Adapter",
		"deliver",
		"SendOutcome",
		"Session",
		"dial_started",
		"impl Socket for BrowserSocket",
		"impl Timer for BrowserTimer",
	} {
		if !strings.Contains(ws, want) {
			t.Errorf("ui/src/ws.rs must contain %q (client lifecycle wiring)", want)
		}
	}
	// The old silent send must not come back: the native error was discarded
	// and a send on a closed socket was a no-op.
	if strings.Contains(ws, "let _ = live.socket.send_with_str") {
		t.Error("ui/src/ws.rs must surface send errors, not discard them")
	}
}
