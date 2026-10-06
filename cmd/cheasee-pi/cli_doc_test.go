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

// TestCLIDoc_SkillRepoFlagRow verifies the --skill-repo flag row mirrors the
// flag-help wording ("Custom skills …") — the doc half of the terminology
// contract; no doc↔CLI parity harness exists, so this string guard is the
// only check on the doc side. The "skill repos" rows elsewhere are untouched.
func TestCLIDoc_SkillRepoFlagRow(t *testing.T) {
	content := readCliDoc(t)
	row := "| `--skill-repo <spec>` | Custom skills installed into the container (repeatable) |"
	if !strings.Contains(content, row) {
		t.Errorf("docs/cli.md --skill-repo row must be %q", row)
	}
	for _, gone := range []string{"custom skill/extension", "Skill/extension"} {
		if strings.Contains(content, gone) {
			t.Errorf("docs/cli.md must not contain %q (one consistent term)', got: %s", gone, content)
		}
	}
	for _, keep := range []string{"records custom skill repos", "skill repos"} {
		if !strings.Contains(content, keep) {
			t.Errorf("docs/cli.md 'skill repos' rows must stay (kept delivery-source wording), missing %q", keep)
		}
	}
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

// TestCLIDoc_AtAGlanceBlastRadius verifies the "At a glance" table mirrors
// each destructive command's blast-radius Short verbatim — catches a Short
// edit that did not reach docs/cli.md.
func TestCLIDoc_AtAGlanceBlastRadius(t *testing.T) {
	content := readCliDoc(t)
	for _, tc := range destructiveShorts {
		if !strings.Contains(content, tc.short) {
			t.Errorf("docs/cli.md should mirror %s's blast-radius Short %q", tc.name, tc.short)
		}
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

// ──────────────────────────────────────────────
// Phase 5: UI control-center docs guards
// ──────────────────────────────────────────────

// uiSection returns the markdown slice from the "## UI" heading to the next
// "## " heading (or EOF). ok is false when the doc has no "## UI" heading.
// Scoping matters: the UI-anchored tokens also appear in the CodeFlow rows, so
// a whole-file substring check would pass on CodeFlow text alone.
func uiSection(content string) (string, bool) {
	lines := strings.Split(content, "\n")
	start := -1
	for i, line := range lines {
		if strings.HasPrefix(line, "## UI") {
			start = i
			break
		}
	}
	if start < 0 {
		return "", false
	}
	for j := start + 1; j < len(lines); j++ {
		if strings.HasPrefix(lines[j], "## ") {
			return strings.Join(lines[start:j], "\n"), true
		}
	}
	return strings.Join(lines[start:], "\n"), true
}

// uiDocSection reads path and returns its "## UI" section, failing the test
// when the heading is missing.
func uiDocSection(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	section, ok := uiSection(string(data))
	if !ok {
		t.Fatalf("%s must contain a `## UI` section", path)
	}
	return section
}

// TestUISection_SlicesToNextHeading verifies the section slicer returns only
// the UI block, reports ok=false when the heading is absent, and runs to EOF
// for a trailing "## UI" section.
func TestUISection_SlicesToNextHeading(t *testing.T) {
	content := "## CodeFlow\nCODEFLOW_PORT 127.0.0.1 loopback\n\n## UI (web control center)\nℹ UI: PI_UI_PORT docker.uiPort\n\n## Run pi\ndocker exec\n"
	got, ok := uiSection(content)
	if !ok {
		t.Fatal("expected a ## UI section")
	}
	if !strings.Contains(got, "ℹ UI:") {
		t.Errorf("uiSection must include the UI block, got %q", got)
	}
	for _, gone := range []string{"CODEFLOW_PORT", "docker exec"} {
		if strings.Contains(got, gone) {
			t.Errorf("uiSection must stop at the next heading, leaked %q in %q", gone, got)
		}
	}

	if _, ok := uiSection("## CodeFlow\nCODEFLOW_PORT\n"); ok {
		t.Error("uiSection must report ok=false when no ## UI heading exists")
	}

	last, ok := uiSection("## UI\nℹ UI: PI_UI_PORT\n")
	if !ok || !strings.Contains(last, "PI_UI_PORT") {
		t.Errorf("uiSection must run to EOF for a trailing ## UI section, got %q ok=%v", last, ok)
	}
}

// TestUISection_AntiFalsePass proves the UI guards cannot be satisfied by
// CodeFlow text: a doc carrying only CodeFlow tokens yields no UI section and
// no UI-anchored token, so a guard keyed on the UI section rejects it.
func TestUISection_AntiFalsePass(t *testing.T) {
	content := "## CodeFlow (code-structure visualization)\nCODEFLOW_PORT 127.0.0.1 loopback\n"
	if _, ok := uiSection(content); ok {
		t.Fatal("CodeFlow-only content must not produce a UI section")
	}
	for _, uiToken := range []string{"ℹ UI:", "PI_UI_PORT", "docker.uiPort", ".cheasee-inuse"} {
		if strings.Contains(content, uiToken) {
			t.Errorf("fixture is supposed to be CodeFlow-only, found UI token %q", uiToken)
		}
	}
}

// TestCLIDoc_UILoopbackAndPort verifies cli.md §UI and daily-usage.md §UI carry
// the UI-anchored URL, port precedence, failure marker, and coexistence
// artefacts — and that the stale "placeholder landing page" sentence is gone.
// The tokens are UI-anchored (`ℹ UI:`, `PI_UI_PORT`, `.cheasee-inuse`), so the
// guard cannot pass on CodeFlow text alone.
func TestCLIDoc_UILoopbackAndPort(t *testing.T) {
	cliUI := uiDocSection(t, cliDocPath())
	for _, want := range []string{
		"ℹ UI:",
		"http://127.0.0.1:",
		"PI_UI_PORT",
		"docker.uiPort",
		"CHEASEE_UI_PORT_UNRESOLVED",
		"⚠ UI port:",
		"9500 + fnv32(repo-slug) % 1024",
		"loopback",
	} {
		if !strings.Contains(cliUI, want) {
			t.Errorf("docs/cli.md §UI should state %q", want)
		}
	}
	// Port precedence order: settings > env > derived.
	di, ei, base := strings.Index(cliUI, "docker.uiPort"), strings.Index(cliUI, "PI_UI_PORT"), strings.Index(cliUI, "9500")
	if !(di >= 0 && ei >= 0 && base >= 0 && di < ei && ei < base) {
		t.Errorf("docs/cli.md §UI must state the resolution order docker.uiPort (%d) < PI_UI_PORT (%d) < 9500 (%d)", di, ei, base)
	}

	dailyUI := uiDocSection(t, filepath.Join("..", "..", "docs", "daily-usage.md"))
	for _, want := range []string{
		"ℹ UI:",
		"127.0.0.1",
		"PI_UI_PORT",
		"docker.uiPort",
		"CHEASEE_UI_PORT_UNRESOLVED",
		"cheasee-pi start",
		".cheasee-inuse",
		"is in use by another process — fork or clone instead",
		"0.0.0.0:3000",
	} {
		if !strings.Contains(dailyUI, want) {
			t.Errorf("docs/daily-usage.md §UI should state %q", want)
		}
	}
	for _, gone := range []string{"placeholder landing page", "RPC endpoints arrive", "later slices"} {
		if strings.Contains(dailyUI, gone) {
			t.Errorf("docs/daily-usage.md §UI must not contain the stale phrase %q", gone)
		}
	}
}

// TestArchitectureDoc_UIServiceBindInvariant verifies architecture.md §UI
// documents the ui service alongside cheasee-pi/codeflow, the loopback-only
// publish pin, the distinct host/container binds, and the no-docker.sock
// decision.
func TestArchitectureDoc_UIServiceBindInvariant(t *testing.T) {
	section := uiDocSection(t, filepath.Join("..", "..", "docs", "architecture.md"))
	for _, want := range []string{
		"cheasee-pi",
		"codeflow",
		"127.0.0.1",
		"0.0.0.0:3000",
		"docker.sock",
		"loopback",
	} {
		if !strings.Contains(section, want) {
			t.Errorf("docs/architecture.md §UI should state %q", want)
		}
	}
	if !strings.Contains(section, "does not mount") && !strings.Contains(section, "never") {
		t.Error("docs/architecture.md §UI must state that docker.sock is not mounted")
	}
}

// TestSecurityDoc_UILoopbackDeferral verifies security.md §UI states the
// loopback-only default, the ui sidecar, and the #1527 non-localhost deferral,
// and that the now-false "no network-exposed services" container claim is gone.
func TestSecurityDoc_UILoopbackDeferral(t *testing.T) {
	section := uiDocSection(t, filepath.Join("..", "..", "docs", "security.md"))
	for _, want := range []string{"ui", "127.0.0.1", "loopback", "#1527"} {
		if !strings.Contains(section, want) {
			t.Errorf("docs/security.md §UI should state %q", want)
		}
	}
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "security.md"))
	if err != nil {
		t.Fatalf("reading docs/security.md: %v", err)
	}
	if strings.Contains(string(data), "The container has no network-exposed services") {
		t.Error("docs/security.md must not claim the container has no network-exposed services (the ui sidecar publishes a port)")
	}
}

// TestCLIDoc_CodeflowMtsExtensions verifies daily-usage.md §CodeFlow
// Limitations documents that the local shim classifies .mts/.cts as
// TypeScript (issue #1907).
func TestCLIDoc_CodeflowMtsExtensions(t *testing.T) {
	daily, err := os.ReadFile(filepath.Join("..", "..", "docs", "daily-usage.md"))
	if err != nil {
		t.Fatalf("reading docs/daily-usage.md: %v", err)
	}
	if !strings.Contains(string(daily), ".mts") || !strings.Contains(string(daily), ".cts") {
		t.Error("daily-usage.md §CodeFlow Limitations should document that .mts/.cts are treated as TypeScript")
	}
}

// TestUIDocs_Pre28L2Caveat guards the audit remedy: every UI doc must describe
// the publish as loopback-bound configuration and disclose Docker's pre-28
// same-L2 exposure caveat, so the unqualified "never routable off-host"
// guarantee cannot silently return before #1527 hardens the mapping.
func TestUIDocs_Pre28L2Caveat(t *testing.T) {
	for _, rel := range []string{
		filepath.Join("..", "..", "docs", "architecture.md"),
		filepath.Join("..", "..", "docs", "cli.md"),
		filepath.Join("..", "..", "docs", "daily-usage.md"),
		filepath.Join("..", "..", "docs", "security.md"),
	} {
		data, err := os.ReadFile(rel)
		if err != nil {
			t.Fatalf("reading %s: %v", rel, err)
		}
		section, ok := uiSection(string(data))
		if !ok {
			t.Fatalf("%s must contain a `## UI` section", rel)
		}
		for _, want := range []string{"28.0.0", "L2"} {
			if !strings.Contains(section, want) {
				t.Errorf("%s §UI should disclose the Docker pre-28 same-L2 caveat (%q)", rel, want)
			}
		}
		if strings.Contains(string(data), "never routable off-host") {
			t.Errorf("%s must not make an unqualified `never routable off-host` claim", rel)
		}
	}
}
