package main

import (
	"os"
	"path/filepath"
	"regexp"
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

// TestUI_EventWidgets guards the slice that renders the remaining event
// families. The Rust suite asserts the reducers; this static guard covers the
// wiring the host suite cannot (keyed rendering, single retry/compaction
// surface, copyable text, streaming-announcement policy).
func TestUI_EventWidgets(t *testing.T) {
	message := uiAsset(t, "src", "components", "message.rs")
	if !strings.Contains(message, "<For") || !strings.Contains(message, "rows") {
		t.Error("components/message.rs must render the transcript with a keyed <For> over rows (AC5)")
	}
	if strings.Contains(message, "collect_view") {
		t.Error("components/message.rs must not rebuild the whole transcript per flush (no collect_view)")
	}

	// One retry/compaction surface only: the inline spans moved to banners.rs.
	controls := uiAsset(t, "src", "components", "controls.rs")
	for _, gone := range []string{"retry-banner", "compacting"} {
		if strings.Contains(controls, gone) {
			t.Errorf("components/controls.rs must not render %q — it lives in banners.rs", gone)
		}
	}

	banners := uiAsset(t, "src", "components", "banners.rs")
	for _, want := range []string{"compaction-banner", "retry-pill", "row-marker", "aria-live"} {
		if !strings.Contains(banners, want) {
			t.Errorf("components/banners.rs must contain %q", want)
		}
	}

	// Tool output stays plain text: no user-select rule may disable selection.
	css := uiAsset(t, "style", "main.css")
	if strings.Contains(css, "user-select") {
		t.Error("style/main.css must not set user-select — tool output must stay copyable (AC5)")
	}
	if strings.Contains(css, "content-visibility: auto") && !strings.Contains(css, "contain-intrinsic-size") {
		t.Error("content-visibility: auto needs contain-intrinsic-size or the scrollbar jumps")
	}

	tool := uiAsset(t, "src", "components", "tool_card.rs")
	if !strings.Contains(tool, `aria-live="off"`) && !strings.Contains(tool, "aria-busy") {
		t.Error("components/tool_card.rs streaming body must be aria-live=\"off\" or aria-busy")
	}
}

// piVersionArgPattern matches the Dockerfile's `ARG PI_VERSION=<default>` line.
var piVersionArgPattern = regexp.MustCompile(`(?m)^ARG PI_VERSION=(\S+)$`)

func dockerfilePiVersionDefault(t *testing.T, content, name string) string {
	t.Helper()
	m := piVersionArgPattern.FindStringSubmatch(content)
	if m == nil {
		t.Fatalf("%s must declare ARG PI_VERSION=<default>", name)
	}
	return m[1]
}

// TestUI_DockerfileShipsPi proves the spawned `pi --mode rpc` binary exists in
// the ui image and that the child's HOME points at the mounted config dir
// (AC3/AC5). Without `pi` the spawn itself fails at runtime.
func TestUI_DockerfileShipsPi(t *testing.T) {
	df := uiAsset(t, "Dockerfile")
	for _, want := range []string{
		"@earendil-works/pi-coding-agent@${PI_VERSION}",
		"setup_22.x",
		"HOME=/home/agentuser",
		"/home/agentuser/.config",
	} {
		if !strings.Contains(df, want) {
			t.Errorf("ui/Dockerfile must contain %q", want)
		}
	}
}

// TestUI_DockerfileEmbedsProviderEnvMap guards the compile-time input:
// `include_str!("../provider_env_map.json")` in src/auth.rs fails the image
// build if the file is not copied into the builder stage.
func TestUI_DockerfileEmbedsProviderEnvMap(t *testing.T) {
	df := uiAsset(t, "Dockerfile")
	if !strings.Contains(df, "COPY provider_env_map.json") {
		t.Error("ui/Dockerfile must COPY provider_env_map.json into the builder stage (include_str! input)")
	}
}

// TestUI_DockerfilePiVersionMatchesPiImage pins the ui image's pi version to
// the pi image's, so the UI-spawned child is the exact build the terminal
// client runs (AC5).
func TestUI_DockerfilePiVersionMatchesPiImage(t *testing.T) {
	ui := dockerfilePiVersionDefault(t, uiAsset(t, "Dockerfile"), "ui/Dockerfile")
	pi := dockerfilePiVersionDefault(t, readDockerfile(t), "docker/Dockerfile")
	if ui != pi {
		t.Errorf("ui/Dockerfile PI_VERSION=%q must match docker/Dockerfile PI_VERSION=%q", ui, pi)
	}
}

// TestUI_PiVersionSidecarMatchesDockerfiles guards the runtime/type skew: the
// JSONL fixtures record the pi version their wire vocabulary was captured from,
// so the image that runs pi must be that same version. A newer runtime pi would
// otherwise answer a command set the fixtures never saw.
func TestUI_PiVersionSidecarMatchesDockerfiles(t *testing.T) {
	sidecar := strings.TrimSpace(uiAsset(t, "tests", "fixtures", "PI_VERSION"))
	at := strings.LastIndex(sidecar, "@")
	if at < 0 || at == len(sidecar)-1 {
		t.Fatalf("PI_VERSION sidecar must be @scope/pkg@version, got %q", sidecar)
	}
	sidecarVersion := sidecar[at+1:]

	ui := dockerfilePiVersionDefault(t, uiAsset(t, "Dockerfile"), "ui/Dockerfile")
	pi := dockerfilePiVersionDefault(t, readDockerfile(t), "docker/Dockerfile")
	if sidecarVersion != ui || sidecarVersion != pi {
		t.Errorf(
			"fixture sidecar pi=%q must equal ui/Dockerfile=%q and docker/Dockerfile=%q",
			sidecarVersion, ui, pi,
		)
	}
}

// TestUI_SBOMDocumentsStack keeps the image inventory honest: the web stack is
// shipped in the ui image, so the SBOM must name it.
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
