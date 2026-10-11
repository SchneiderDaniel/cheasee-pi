package main

import (
	"path/filepath"
	"strings"
	"testing"
)

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
