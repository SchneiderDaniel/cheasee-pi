package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func buildCostDocSection(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "development.md"))
	if err != nil {
		t.Fatalf("reading docs/development.md: %v", err)
	}
	section, ok := markdownSection(string(data), "## Measuring image build cost")
	if !ok {
		t.Fatal("docs/development.md must contain a `## Measuring image build cost` section")
	}
	return section
}

func TestBuildCostDoc_RecordsBothScenarios(t *testing.T) {
	// #2053 turned on two separate mechanisms (cache mounts fix a re-run, the
	// scrapling stage + digest pins fix an evicted cache). A measurement section
	// that only quotes one number would hide which of the two it measured.
	section := buildCostDocSection(t)
	for _, want := range []string{
		"Fully cold",
		"Agent-layer invalidation",
		"docker buildx prune -af",
		"docker buildx du",
		"docker images --format",
		"--progress=plain",
		"cdn.playwright.dev", // recipe that measures transfer volume without a daemon
	} {
		if !strings.Contains(section, want) {
			t.Errorf("docs/development.md §Measuring image build cost must contain %q", want)
		}
	}
}

func TestBuildCostDoc_LabelsUnmeasuredWallClock(t *testing.T) {
	// The audit of #2053 rejected a table cell that presented a figure derived
	// from the baseline as if a build had been timed. Keep the gap labelled: a
	// derived number must not read as a measurement.
	section := buildCostDocSection(t)
	if !strings.Contains(section, "not measured") {
		t.Error("the unmeasured post-change wall clock must be labelled `not measured`")
	}
	for _, claim := range []string{"min (measured)", "GB (measured)", "measured build"} {
		for _, line := range strings.Split(section, "\n") {
			if strings.Contains(line, "After") && strings.Contains(line, claim) {
				t.Errorf("an `After` cell must not claim a measurement it does not have: %q", line)
			}
		}
	}
}
