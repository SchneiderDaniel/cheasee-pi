package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/pflag"
)

// cliDocPath is the path to the CLI reference doc relative to this test file.
func cliDocPath() string {
	// Test runs from the package directory (cmd/cheasee-pi/).
	return filepath.Join("..", "..", "docs", "cli.md")
}

func readCliDoc(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(cliDocPath())
	if err != nil {
		t.Fatalf("reading docs/cli.md: %v", err)
	}
	return string(data)
}

// readNavOrder extracts the nav_order value from a doc's Jekyll frontmatter.
func readNavOrder(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	inFront := false
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "---" {
			if inFront {
				break
			}
			inFront = true
			continue
		}
		if inFront && strings.HasPrefix(trimmed, "nav_order:") {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, "nav_order:"))
		}
	}
	return ""
}

// ──────────────────────────────────────────────
// Phase 1: Page shell & nav
// ──────────────────────────────────────────────

// TestCLIDoc_ExistsAndFrontmatter verifies docs/cli.md exists with the
// just-the-docs frontmatter contract (layout, title, unique fractional
// nav_order slotting between installation=2 and daily-usage=3).
func TestCLIDoc_ExistsAndFrontmatter(t *testing.T) {
	content := readCliDoc(t)
	if !strings.Contains(content, "layout: default") {
		t.Error("docs/cli.md must declare layout: default in frontmatter")
	}
	if !strings.Contains(content, "title: CLI Reference") {
		t.Error("docs/cli.md must declare title: CLI Reference in frontmatter")
	}
	if readNavOrder(t, cliDocPath()) != "2.5" {
		t.Error("docs/cli.md must declare nav_order: 2.5 in frontmatter")
	}
}

// TestCLIDoc_NavOrderUnique verifies every docs/*.md has a distinct nav_order,
// cli.md uses 2.5, and the pre-existing 1–11 values are unchanged (no
// renumbering — the page slots into the flat nav without touching siblings).
func TestCLIDoc_NavOrderUnique(t *testing.T) {
	entries, err := os.ReadDir(filepath.Join("..", "..", "docs"))
	if err != nil {
		t.Fatalf("listing docs/: %v", err)
	}

	existing := map[string]string{
		"index.md":            "1",
		"installation.md":     "2",
		"daily-usage.md":      "3",
		"architecture.md":     "4",
		"skills.md":           "5",
		"prompts.md":          "6",
		"extensions.md":       "7",
		"github.md":           "8",
		"security.md":         "9",
		"sbom.md":             "10",
		"acknowledgements.md": "11",
	}

	seen := make(map[string]string)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		path := filepath.Join("..", "..", "docs", e.Name())
		order := readNavOrder(t, path)
		if order == "" {
			continue // README.md (included via index.md) has no nav_order
		}
		if want, ok := existing[e.Name()]; ok && order != want {
			t.Errorf("docs/%s nav_order changed from %q to %q — renumbering is not allowed", e.Name(), want, order)
		}
		if prev, dup := seen[order]; dup {
			t.Errorf("nav_order collision: docs/%s and docs/%s both use %q", prev, e.Name(), order)
		}
		seen[order] = e.Name()
	}
	if seen["2.5"] != "cli.md" {
		t.Errorf("nav_order 2.5 must belong to cli.md, got %q", seen["2.5"])
	}
}

// ──────────────────────────────────────────────
// Phase 2: Command surface sync
// ──────────────────────────────────────────────

// TestCLIDoc_AllTopLevelCommands verifies every top-level command registered
// on rootCmd (excluding Cobra built-ins) is documented in cli.md.
func TestCLIDoc_AllTopLevelCommands(t *testing.T) {
	content := readCliDoc(t)
	for _, c := range rootCmd.Commands() {
		if builtInCmds[c.Name()] {
			continue
		}
		if !strings.Contains(content, c.Name()) {
			t.Errorf("docs/cli.md should document top-level command %q", c.Name())
		}
	}
}

// TestCLIDoc_AliasesDocumented verifies the documented aliases: no-args
// invocation = start, start alias up, down alias stop.
func TestCLIDoc_AliasesDocumented(t *testing.T) {
	content := readCliDoc(t)
	if !strings.Contains(content, "(no args)") {
		t.Error("docs/cli.md should state that `cheasee-pi` with no args runs start")
	}
	if !strings.Contains(content, "`up`") {
		t.Error("docs/cli.md should document the `up` alias for start")
	}
	if !strings.Contains(content, "`stop`") {
		t.Error("docs/cli.md should document the `stop` alias for down")
	}
}

// TestCLIDoc_AllInitFlags verifies every registered init flag appears in
// cli.md with its one-line meaning (mandated 8 + code-truth --reauth and
// --skill-repo).
func TestCLIDoc_AllInitFlags(t *testing.T) {
	content := readCliDoc(t)
	initCmd.Flags().VisitAll(func(f *pflag.Flag) {
		if !strings.Contains(content, "--"+f.Name) {
			t.Errorf("docs/cli.md should document init flag --%s", f.Name)
		}
	})
}

// TestCLIDoc_StartAndAuthFlags verifies the auth subcommands and start flags
// are documented.
func TestCLIDoc_StartAndAuthFlags(t *testing.T) {
	content := readCliDoc(t)
	for _, sub := range []string{"auth add", "auth remove", "auth list", "auth envvars"} {
		if !strings.Contains(content, sub) {
			t.Errorf("docs/cli.md should document `cheasee-pi %s`", sub)
		}
	}
	for _, flag := range []string{"--build", "--api-key", "--no-docker-check", "--dry-run", "--name", "--workdir"} {
		if !strings.Contains(content, flag) {
			t.Errorf("docs/cli.md should document start flag %s", flag)
		}
	}
}

// ──────────────────────────────────────────────
// Phase 3: Checks / behavioral claims
// ──────────────────────────────────────────────

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
// timeout, --no-input requiring --repo-url, --no-github legacy path, and
// start auto-init in the same invocation.
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
		{"same invocation", "start auto-init continuation"},
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
func TestCLIDoc_CleanSemantics(t *testing.T) {
	content := readCliDoc(t)
	for _, s := range []string{"ALL managed containers", "force-remove", "--name", "--dry-run", "--yes", "--older-than"} {
		if !strings.Contains(content, s) {
			t.Errorf("docs/cli.md should state clean's %q semantics", s)
		}
	}
}

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
func TestCLIDoc_Visualization(t *testing.T) {
	content := readCliDoc(t)
	if !strings.Contains(content, "|") {
		t.Error("docs/cli.md should contain at least one |-delimited markdown table")
	}
	if !strings.Contains(content, "At a glance") {
		t.Error("docs/cli.md should have an at-a-glance command overview")
	}
}

// TestCLIDoc_LinksToDepth verifies the one-directional links: cli.md links
// to installation.md and daily-usage.md, and both link back to cli.md.
func TestCLIDoc_LinksToDepth(t *testing.T) {
	content := readCliDoc(t)
	for _, link := range []string{"installation.md", "daily-usage.md"} {
		if !strings.Contains(content, link) {
			t.Errorf("docs/cli.md should link to %s", link)
		}
	}
	readDoc := func(path string) string {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("reading %s: %v", path, err)
		}
		return string(data)
	}
	for _, path := range []string{
		filepath.Join("..", "..", "docs", "installation.md"),
		filepath.Join("..", "..", "docs", "daily-usage.md"),
	} {
		if !strings.Contains(readDoc(path), "cli.md") {
			t.Errorf("%s should link to cli.md", filepath.Base(path))
		}
	}
}

// TestCLIDoc_NoTutorialDuplication verifies cli.md stays a reference page:
// no install one-liner (curl / VERSION= snippet) and no troubleshooting
// section — those live in installation.md / daily-usage.md.
func TestCLIDoc_NoTutorialDuplication(t *testing.T) {
	content := readCliDoc(t)
	for _, banned := range []string{"curl", "VERSION=", "Troubleshooting"} {
		if strings.Contains(content, banned) {
			t.Errorf("docs/cli.md must not contain %q (tutorial detail belongs in installation.md / daily-usage.md)", banned)
		}
	}
}
