package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
