package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCLIDoc_StartReuse(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "cli.md"))
	if err != nil {
		t.Fatalf("reading docs/cli.md: %v", err)
	}
	section, ok := markdownSection(string(data), "## `cheasee-pi` (no args) / `start`")
	if !ok {
		t.Fatal("docs/cli.md must keep the start section heading")
	}
	for _, want := range []string{"without rebuilding", "creates only missing", "builds only missing"} {
		if !strings.Contains(section, want) {
			t.Errorf("start docs must state %q, got:\n%s", want, section)
		}
	}
	if strings.Contains(section, "`docker compose up` if not running") {
		t.Errorf("start docs still describe the old compose-up-if-not-running flow:\n%s", section)
	}
	if strings.Contains(upCmd.Long, "starts it with docker compose up first") {
		t.Errorf("start --help still claims compose up if not running:\n%s", upCmd.Long)
	}
	if !strings.Contains(upCmd.Long, "--build") {
		t.Errorf("start --help must keep documenting --build:\n%s", upCmd.Long)
	}
}

// TestCLIDoc_DockerGate verifies the Docker gate (binary + docker info +
// Engine ≥ 24.0.0, 5 s timeout) and the --no-docker-check skip are stated.
func TestCLIDoc_DockerGate(t *testing.T) {
	content := readCliDoc(t)
	if !strings.Contains(content, "24.0.0") {
		t.Error("docs/cli.md should state the Docker Engine ≥ 24.0.0 requirement")
	}
	if !strings.Contains(content, "5 s") {
		t.Error("docs/cli.md should state the 5 s docker check timeout")
	}
	if !strings.Contains(content, "--no-docker-check") {
		t.Error("docs/cli.md should state that --no-docker-check skips the Docker check")
	}
}

// TestCLIDoc_InitGates verifies the init preconditions: empty-folder gate,
// cheasee-settings.json as initialized marker, non-empty refusal, 5-minute
// timeout, --no-input requiring --repo-url, --no-github legacy path, and the
// init-stops-then-start handoff.

// TestCLIDoc_InitGates verifies the init preconditions: empty-folder gate,
// cheasee-settings.json as initialized marker, non-empty refusal, 5-minute
// timeout, --no-input requiring --repo-url, --no-github legacy path, and the
// init-stops-then-start handoff.
func TestCLIDoc_InitGates(t *testing.T) {
	content := readCliDoc(t)
	checks := []struct {
		want, msg string
	}{
		{"empty folder", "empty-folder requirement"},
		{"non-empty folders are refused", "refusal of non-empty folders"},
		{"initialized", "cheasee-settings.json as initialized marker"},
		{"5-minute", "5-minute init/OAuth timeout"},
		{"--no-input` requires `--repo-url", "--no-input requires --repo-url"},
		{"--no-github", "--no-github legacy path"},
		{"re-run `start` to launch pi", "init-stops-then-start handoff"},
	}
	for _, c := range checks {
		if !strings.Contains(content, c.want) {
			t.Errorf("docs/cli.md should state: %s", c.msg)
		}
	}
	if !strings.Contains(content, "cheasee-settings.json") {
		t.Error("docs/cli.md should reference cheasee-settings.json")
	}
}

// TestCLIDoc_CleanSemantics verifies clean's cross-workspace blast radius
// and its scoping flags.

// TestCLIDoc_CleanSemantics verifies clean's cross-workspace blast radius
// and its scoping flags.
func TestCLIDoc_CleanSemantics(t *testing.T) {
	content := readCliDoc(t)
	for _, s := range []string{"ALL managed containers", "force-remove", "--name", "--dry-run", "--yes", "--older-than"} {
		if !strings.Contains(content, s) {
			t.Errorf("docs/cli.md should state clean's %q semantics", s)
		}
	}
}

// TestCLIDoc_PruneImagesSemantics verifies prune-images' blast radius and
// safety contract are documented: all tagged cheasee-pi-* images on the host
// are removed, images are regenerable via build/rebuild, the command refuses
// while managed containers exist (clean first), --dry-run/--yes, approximate
// (upper-bound) sizes, and the host-wide build-cache blast on the shared
// builder.

// TestCLIDoc_PruneImagesSemantics verifies prune-images' blast radius and
// safety contract are documented: all tagged cheasee-pi-* images on the host
// are removed, images are regenerable via build/rebuild, the command refuses
// while managed containers exist (clean first), --dry-run/--yes, approximate
// (upper-bound) sizes, and the host-wide build-cache blast on the shared
// builder.
func TestCLIDoc_PruneImagesSemantics(t *testing.T) {
	content := readCliDoc(t)
	for _, s := range []string{
		"cheasee-pi-*",            // name-scoped blast radius
		"regenerable via",         // images are rebuild artifacts, not state
		"`cheasee-pi build`",      // regenerable path 1
		"`cheasee-pi rebuild`",    // regenerable path 2
		"cheasee-pi clean` first", // managed-container gate
		"--dry-run",               // preview
		"--yes",                   // skip confirmation
		"approximate",             // upper-bound sizes
		"other projects",          // host-wide cache blast disclosed
	} {
		if !strings.Contains(content, s) {
			t.Errorf("docs/cli.md should state prune-images' %q semantics", s)
		}
	}
}

// TestCLIDoc_DownSemantics verifies down targets only the current
// workspace's compose project, no-ops when nothing matches, and excludes
// legacy pre-derivation containers (clean removes those).

// TestCLIDoc_DownSemantics verifies down targets only the current
// workspace's compose project, no-ops when nothing matches, and excludes
// legacy pre-derivation containers (clean removes those).
func TestCLIDoc_DownSemantics(t *testing.T) {
	content := readCliDoc(t)
	for _, s := range []string{"current workspace", "No-ops", "`cheasee-pi clean` removes those"} {
		if !strings.Contains(content, s) {
			t.Errorf("docs/cli.md should state down's %q semantics", s)
		}
	}
}

// TestCLIDoc_BuildApply verifies the cached-build apply step is documented.

// TestCLIDoc_BuildApply verifies the cached-build apply step is documented.
func TestCLIDoc_BuildApply(t *testing.T) {
	content := readCliDoc(t)
	if !strings.Contains(content, "start --build") {
		t.Error("docs/cli.md should state applying a build via `cheasee-pi start --build`")
	}
	if !strings.Contains(content, "`cheasee-pi down` + `cheasee-pi start`") {
		t.Error("docs/cli.md should state the down + start apply path")
	}
}

// TestCLIDoc_AuthRemoveDefaults verifies auth remove leaves the workspace
// default untouched and switching requires auth add.

// TestCLIDoc_AuthRemoveDefaults verifies auth remove leaves the workspace
// default untouched and switching requires auth add.
func TestCLIDoc_AuthRemoveDefaults(t *testing.T) {
	content := readCliDoc(t)
	for _, s := range []string{"defaultProvider", "defaultModel", "`cheasee-pi auth add <other>`"} {
		if !strings.Contains(content, s) {
			t.Errorf("docs/cli.md should state that auth remove leaves %q", s)
		}
	}
}

// TestCLIDoc_ContainerNaming verifies the per-repo container name and the
// sibling .bare mount are documented.

// TestCLIDoc_ContainerNaming verifies the per-repo container name and the
// sibling .bare mount are documented.
func TestCLIDoc_ContainerNaming(t *testing.T) {
	content := readCliDoc(t)
	if !strings.Contains(content, "cheasee-pi-<repo-slug>") {
		t.Error("docs/cli.md should state the per-repo container name cheasee-pi-<repo-slug>")
	}
	if !strings.Contains(content, "/workspaces/.bare") {
		t.Error("docs/cli.md should state the sibling .bare mount at /workspaces/.bare")
	}
}

// ──────────────────────────────────────────────
// Phase 4: Inputs, visualization, links
// ──────────────────────────────────────────────

// TestCLIDoc_ProviderEnvVarsMatchCode verifies every env var name the CLI
// probes (provider vars + passthrough) appears in cli.md, and that
// CODEFLOW_PORT documents the resolution order.

// TestCLIDoc_ProviderEnvVarsMatchCode verifies every env var name the CLI
// probes (provider vars + passthrough) appears in cli.md, and that
// CODEFLOW_PORT documents the resolution order.
func TestCLIDoc_ProviderEnvVarsMatchCode(t *testing.T) {
	content := readCliDoc(t)
	for _, name := range AllEnvVarNames() {
		if !strings.Contains(content, name) {
			t.Errorf("docs/cli.md should document env var %s", name)
		}
	}
	if !strings.Contains(content, "CODEFLOW_PORT") {
		t.Error("docs/cli.md should document CODEFLOW_PORT")
	}
	if !strings.Contains(content, "codeflowPort") {
		t.Error("docs/cli.md should document the docker.codeflowPort settings source")
	}
}

// TestCLIDoc_CodeflowLoopbackOnly verifies the docs match the ingress fix:
// cli.md documents CODEFLOW_HOST_IP with its loopback default and 0.0.0.0
// opt-in, and daily-usage.md §CodeFlow no longer claims a server-side
// 127.0.0.1 host value (container-side must stay 0.0.0.0 for
// docker-proxy/DNAT delivery) while stating the loopback-only default.

// TestCLIDoc_CodeflowLoopbackOnly verifies the docs match the ingress fix:
// cli.md documents CODEFLOW_HOST_IP with its loopback default and 0.0.0.0
// opt-in, and daily-usage.md §CodeFlow no longer claims a server-side
// 127.0.0.1 host value (container-side must stay 0.0.0.0 for
// docker-proxy/DNAT delivery) while stating the loopback-only default.
func TestCLIDoc_CodeflowLoopbackOnly(t *testing.T) {
	content := readCliDoc(t)
	if !strings.Contains(content, "CODEFLOW_HOST_IP") {
		t.Error("docs/cli.md should document CODEFLOW_HOST_IP")
	}
	if !strings.Contains(content, "127.0.0.1") {
		t.Error("docs/cli.md should state the loopback default (127.0.0.1)")
	}
	if !strings.Contains(content, "0.0.0.0") {
		t.Error("docs/cli.md should document the 0.0.0.0 remote-access opt-in")
	}

	daily, err := os.ReadFile(filepath.Join("..", "..", "docs", "daily-usage.md"))
	if err != nil {
		t.Fatalf("reading docs/daily-usage.md: %v", err)
	}
	if strings.Contains(string(daily), "`127.0.0.1` restricts access to localhost") {
		t.Error("daily-usage.md must not claim host: 127.0.0.1 is a valid server-side bind (container-side stays 0.0.0.0)")
	}
	if !strings.Contains(string(daily), "CODEFLOW_HOST_IP") {
		t.Error("daily-usage.md §CodeFlow should document CODEFLOW_HOST_IP")
	}
	if !strings.Contains(string(daily), "loopback") {
		t.Error("daily-usage.md §CodeFlow should state the loopback-only default")
	}
}

// TestCLIDoc_FilesReadWritten verifies the documented files: auth.json (0600),
// cheasee-settings.json, version-keyed cache dir, and .pi/.

// TestCLIDoc_FilesReadWritten verifies the documented files: auth.json (0600),
// cheasee-settings.json, version-keyed cache dir, and .pi/.
func TestCLIDoc_FilesReadWritten(t *testing.T) {
	content := readCliDoc(t)
	for _, s := range []string{"auth.json", "0600", "cheasee-settings.json", "UserCacheDir", ".pi/"} {
		if !strings.Contains(content, s) {
			t.Errorf("docs/cli.md should document %s", s)
		}
	}
}

// TestCLIDoc_Visualization verifies at least one markdown table gives the
// at-a-glance command surface.

// TestCLIDoc_Visualization verifies at least one markdown table gives the
// at-a-glance command surface.
func TestCLIDoc_Visualization(t *testing.T) {
	content := readCliDoc(t)
	if !strings.Contains(content, "|") {
		t.Error("docs/cli.md should contain at least one |-delimited markdown table")
	}
	if !strings.Contains(content, "At a glance") {
		t.Error("docs/cli.md should have an at-a-glance command overview")
	}
}

// TestCLIDoc_AtAGlanceBlastRadius verifies the "At a glance" table mirrors
// each destructive command's blast-radius Short verbatim — catches a Short
// edit that did not reach docs/cli.md.
