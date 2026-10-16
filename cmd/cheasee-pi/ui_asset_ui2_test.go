package main

import (
	"regexp"
	"strings"
	"testing"
)

func TestUI_EventWidgets(t *testing.T) {
	message := uiAsset(t, "src", "components", "message.rs")
	if !strings.Contains(message, "<For") || !strings.Contains(message, "rows") {
		t.Error("components/message.rs must render the transcript with a keyed <For> over rows (AC5)")
	}
	if strings.Contains(message, "collect_view") {
		t.Error("components/message.rs must not rebuild the whole transcript per flush (no collect_view)")
	}
	// Each row must read its payload signal, not a captured snapshot, or a
	// same-id delta leaves the row frozen at its first value (AC1/AC5).
	if !strings.Contains(message, "kind.get()") {
		t.Error("components/message.rs must read each row's payload signal so same-id updates reach the view")
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

// TestUI_DockerfileDropsBuildStamp: the cache-busting stamp is scoped to the
// agent image, so the sidecar declares neither the ARG nor its echo (a stamp
// ARG with no supplier is dead residue of the old global `--build-arg`).

func TestUI_DockerfileDropsBuildStamp(t *testing.T) {
	df := uiAsset(t, "Dockerfile")
	for _, gone := range []string{"ARG PI_BUILD_STAMP", "pi-build-stamp"} {
		if strings.Contains(df, gone) {
			t.Errorf("ui/Dockerfile must not contain %q (stamp scope is the agent image)", gone)
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
