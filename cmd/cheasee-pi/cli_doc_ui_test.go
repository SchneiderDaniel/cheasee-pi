package main

import (
	"os"
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
