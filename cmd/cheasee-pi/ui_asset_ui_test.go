package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func TestUI_CargoFeatures(t *testing.T) {
	manifest := uiAsset(t, "Cargo.toml")
	for _, want := range []string{
		"default = []",
		"hydrate = [",
		"ssr = [",
		"crate-type = [\"cdylib\", \"rlib\"]",
		"site-pkg-dir = \"assets\"",
	} {
		if !strings.Contains(manifest, want) {
			t.Errorf("ui/Cargo.toml must contain %q", want)
		}
	}
	for _, forbidden := range []string{"rand =", "getrandom"} {
		if strings.Contains(manifest, forbidden) {
			t.Errorf("ui/Cargo.toml must not declare %s (WASM randomness needs a JS source)", forbidden)
		}
	}

	// One axum major only: leptos_axum re-exports axum types, so a second line
	// in the lock is the two-incompatible-majors failure mode.
	lock := uiAsset(t, "Cargo.lock")
	if got := strings.Count(lock, "\nname = \"axum\"\n"); got != 1 {
		t.Errorf("ui/Cargo.lock must pin exactly one axum major, found %d", got)
	}
}

// TestUI_ProtocolBoundary keeps the shared DTO module transport-free: it is the
// innermost policy slice 4 fills, and must not learn about axum, tokio, or the
// browser. The framing/correlation layer lives in src/rpc/ behind the ssr
// feature instead, so there is exactly one wire vocabulary.

func TestUI_ProtocolBoundary(t *testing.T) {
	src := uiAsset(t, "src", "protocol.rs")
	for _, forbidden := range []string{"use axum", "axum::", "web_sys", "use tokio"} {
		if strings.Contains(src, forbidden) {
			t.Errorf("ui/src/protocol.rs must stay transport-free, found %q", forbidden)
		}
	}
	if _, err := os.Stat(filepath.Join("embedded", "docker", "ui", "src", "rpc", "types.rs")); !os.IsNotExist(err) {
		t.Error("ui/src/rpc/types.rs must not exist — protocol.rs is the single wire vocabulary")
	}
}

// TestUI_DockerfileBuildWiring guards the cargo-leptos build: the wasm target,
// a version-matched wasm-bindgen CLI, the hashed site dir copied into the
// runtime stage, and curl (not wget) for the healthcheck probe.

func TestUI_DockerfileBuildWiring(t *testing.T) {
	df := uiAsset(t, "Dockerfile")
	for _, want := range []string{
		"wasm32-unknown-unknown",
		"cargo-leptos",
		"wasm-bindgen-cli",
		"target/site",
		"curl",
	} {
		if !strings.Contains(df, want) {
			t.Errorf("ui/Dockerfile must contain %q", want)
		}
	}
	if strings.Contains(df, "wget") {
		t.Error("ui/Dockerfile must not mention wget (curl is the probe binary)")
	}
}

// TestUI_DockerfileWasmOptNotDistroBinaryen guards the hydration blocker:
// Debian bookworm's apt binaryen is version 108, whose wasm-opt rewrites
// wasm-bindgen's `__wbindgen_externrefs` export onto the wrong table
// (WebAssembly/binaryen#4736). The funcref table it points at has max == min,
// so `table.grow(4)` at startup throws and the wasm never hydrates — the page
// renders but every button is dead and the session list stays empty. The
// builder must pin a binaryen release >= 110 instead of the distro package.

var binaryenReleasePattern = regexp.MustCompile(`binaryen-version_(\d+)`)

func TestUI_DockerfileWasmOptNotDistroBinaryen(t *testing.T) {
	df := uiAsset(t, "Dockerfile")
	if strings.Contains(df, "install -y --no-install-recommends binaryen") {
		t.Error("ui/Dockerfile must not apt-install binaryen (bookworm ships 108, which breaks wasm-bindgen hydration)")
	}
	m := binaryenReleasePattern.FindStringSubmatch(df)
	if m == nil {
		t.Fatal("ui/Dockerfile must download a pinned binaryen release for wasm-opt")
	}
	version, err := strconv.Atoi(m[1])
	if err != nil {
		t.Fatalf("binaryen release version %q is not an integer", m[1])
	}
	if version < 110 {
		t.Errorf("ui/Dockerfile pins binaryen %d; wasm-opt >= 110 is required (WebAssembly/binaryen#4736)", version)
	}
}

// TestUI_EventWidgets guards the slice that renders the remaining event
// families. The Rust suite asserts the reducers; this static guard covers the
// wiring the host suite cannot (keyed rendering, single retry/compaction
// surface, copyable text, streaming-announcement policy).
