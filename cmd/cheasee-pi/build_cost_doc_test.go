package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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
		"content-range", // recipe that measures transfer volume without a daemon
	} {
		if !strings.Contains(section, want) {
			t.Errorf("docs/development.md §Measuring image build cost must contain %q", want)
		}
	}
}

func TestBuildCostDoc_RecordsMeasuredTransferInventory(t *testing.T) {
	// #2053's last acceptance criterion asks for a measured after-number. The
	// docker build wall clock needs a daemon, but the transfer volume does not:
	// every artifact is measured byte-for-byte over HTTP. A section that drops
	// those rows (back to "not measured" everywhere, or to a derived guess) must
	// fail, otherwise the recorded measurement can silently disappear.
	section := buildCostDocSection(t)
	row := regexp.MustCompile(`(?m)^\|.*\|\s*[0-9,]{6,} B\s*\|`)
	if got := len(row.FindAllString(section, -1)); got < 8 {
		t.Errorf("§Measuring image build cost must record the measured per-artifact byte inventory (found %d byte rows, want >=8)", got)
	}
	for _, stage := range []string{"scrapling", "agent"} {
		if !strings.Contains(section, "| "+stage) {
			t.Errorf("the byte inventory must attribute rows to the %s stage", stage)
		}
	}
	if !strings.Contains(section, "apt-get --print-uris") {
		t.Error("the apt rows must state how they were measured (--print-uris against the pinned base image's package set)")
	}
}

func TestBuildCostDoc_TotalsMatchTheirRows(t *testing.T) {
	// The audit of #2053 found the aggregate carrying bounded apt rows that the
	// per-artifact rows did not support. A subtotal that does not equal the rows
	// above it is that same defect, so it is checked arithmetically instead of
	// trusted.
	section := buildCostDocSection(t)
	row := regexp.MustCompile(`^\|\s*(scrapling|agent|\*\*stage\*\*|\*\*both\*\*)\s*\|\s*([^|]*?)\s*\|\s*\*{0,2}([0-9,]+) B\*{0,2}\s*\|`)

	var stage, artifact string
	perStage := map[string]int{}
	var subtotals, total map[string]int64
	subtotals = map[string]int64{}
	total = map[string]int64{}
	for _, line := range strings.Split(section, "\n") {
		m := row.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		stage, artifact = m[1], m[2]
		bytes, err := strconv.ParseInt(strings.ReplaceAll(m[3], ",", ""), 10, 64)
		if err != nil {
			t.Fatalf("unparsable byte count in %q: %v", line, err)
		}
		switch stage {
		case "scrapling", "agent":
			perStage[stage]++
			subtotals["rows:"+stage] += bytes
		case "**stage**":
			subtotals["stated:"+artifactKey(artifact)] = bytes
		case "**both**":
			total["stated"] = bytes
		}
	}

	for _, name := range []string{"scrapling", "agent"} {
		if perStage[name] < 3 {
			t.Fatalf("expected the byte inventory to list at least 3 %s rows, parsed %d", name, perStage[name])
		}
		if got, want := subtotals["rows:"+name], subtotals["stated:"+name]; got != want {
			t.Errorf("%s subtotal states %d B but its rows sum to %d B", name, want, got)
		}
	}
	if got, want := subtotals["rows:scrapling"]+subtotals["rows:agent"], total["stated"]; got != want {
		t.Errorf("the `both` total states %d B but the stage subtotals sum to %d B", want, got)
	}
}

// artifactKey turns a subtotal's artifact cell into the stage name it belongs
// to, so a subtotal row cannot claim a different stage than the rows above it.
func artifactKey(artifact string) string {
	for _, name := range []string{"scrapling", "agent"} {
		if strings.Contains(artifact, name) {
			return name
		}
	}
	return ""
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
