package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
