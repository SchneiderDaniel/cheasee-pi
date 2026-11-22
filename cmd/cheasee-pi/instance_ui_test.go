package main

import (
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 7: UI instance rows (static source guards)
//
// The gate has no Rust toolchain, so the ui contract is pinned by source
// guards (the established convention in ui_asset_test.go /
// pi_build_stamp_ui_test.go). The reported "Count: 0" control was a demo
// counter with no backend at all: it must be gone, replaced by rows built from
// the CLI-written snapshot.
// ──────────────────────────────────────────────

func TestDiscovery_appHasNoFakeInstanceCounter(t *testing.T) {
	src := uiAsset(t, "src", "app.rs")
	for _, gone := range []string{"fn Counter", `"count: "`, "<Counter"} {
		if strings.Contains(src, gone) {
			t.Errorf("ui/src/app.rs must not carry the never-backed counter control %q — it reads as an instance count and is always 0", gone)
		}
	}
}

func TestDiscovery_bridgeDeclaresInstanceRow(t *testing.T) {
	src := uiAsset(t, "src", "bridge.rs")
	start := strings.Index(src, "pub struct InstanceRow")
	if start < 0 {
		t.Fatal("ui/src/bridge.rs must declare `pub struct InstanceRow`")
	}
	block := src[start:]
	if end := strings.Index(block, "\n}"); end >= 0 {
		block = block[:end]
	}
	// The serde attribute lives on the line(s) before the struct: re-read the
	// preceding doc/attribute window.
	window := src[max(0, start-200):]
	for _, want := range []string{
		`rename_all = "camelCase"`,
		"pub key: String",
		"pub label: String",
		"pub ui_port: String",
		"pub running: bool",
	} {
		if !strings.Contains(window, want) && !strings.Contains(block, want) {
			t.Errorf("InstanceRow must declare %q", want)
		}
	}
}

func TestDiscovery_sessionListRendersInstanceRows(t *testing.T) {
	src := uiAsset(t, "src", "components", "session_list.rs")
	if !strings.Contains(src, "InstanceRow") {
		t.Fatal("ui/src/components/session_list.rs must render InstanceRow rows")
	}
	if !strings.Contains(src, "instances") {
		t.Error("ui/src/components/session_list.rs must render an instances section")
	}
	// The connect target is the peer's OWN ui port — a hardcoded port would
	// point every row at this sidecar.
	if !strings.Contains(src, "row.ui_port") {
		t.Error("the connect link must be built from the row's own ui_port")
	}
	if strings.Contains(src, "9500") {
		t.Error("ui/src/components/session_list.rs must not hardcode the local UI port")
	}
	if !strings.Contains(src, "127.0.0.1") {
		t.Error("the connect link must target loopback (the sidecar publishes on 127.0.0.1 only)")
	}
}

func TestDiscovery_sessionListDistinguishesRunningState(t *testing.T) {
	src := uiAsset(t, "src", "components", "session_list.rs")
	for _, want := range []string{"\"running\"", "\"not running\""} {
		if !strings.Contains(src, want) {
			t.Errorf("ui/src/components/session_list.rs must render the %s label", want)
		}
	}
}

func TestDiscovery_bridgeCarriesInstanceRowsOnTheWire(t *testing.T) {
	src := uiAsset(t, "src", "bridge.rs")
	if !strings.Contains(src, "instances: Vec<InstanceRow>") {
		t.Error("ServerMessage::SessionList must carry the instance rows to the browser")
	}
}
