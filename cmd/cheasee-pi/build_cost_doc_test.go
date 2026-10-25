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
		"scripts/measure-cold-build.sh", // the no-daemon half of the measurement
	} {
		if !strings.Contains(section, want) {
			t.Errorf("docs/development.md §Measuring image build cost must contain %q", want)
		}
	}
}

func TestBuildCostDoc_RecordsMeasuredColdRun(t *testing.T) {
	// #2053's last acceptance criterion asks for a measured after-number, both
	// bytes and seconds. The rows are single observed transfers, so each one
	// must carry a byte count and an elapsed time — a table that drops back to
	// advertised artifact sizes, or to a byte-only inventory, is not the
	// measurement the criterion asks for.
	section := buildCostDocSection(t)
	row := regexp.MustCompile(`(?m)^\|.*\|\s*[0-9,]{6,} B\s*\|\s*[0-9]+(?:\.[0-9])? s\s*\|`)
	if got := len(row.FindAllString(section, -1)); got < 8 {
		t.Errorf("§Measuring image build cost must record the measured per-step transfer and time (found %d rows, want >=8)", got)
	}
	for _, stage := range []string{"scrapling", "agent"} {
		if !strings.Contains(section, "| "+stage) {
			t.Errorf("the measurement must attribute rows to the %s stage", stage)
		}
	}
	if !strings.Contains(section, "scripts/measure-cold-build.sh") {
		t.Error("the numbers must name the script that produces them")
	}
	if _, err := os.Stat(filepath.Join("..", "..", "scripts", "measure-cold-build.sh")); err != nil {
		t.Errorf("the documented measurement script must exist: %v", err)
	}
}

func TestBuildCostDoc_TotalsMatchTheirRows(t *testing.T) {
	// The audit of #2053 found the aggregate carrying bounded apt rows that the
	// per-artifact rows did not support. A subtotal that does not equal the rows
	// above it is that same defect, so it is checked arithmetically instead of
	// trusted.
	section := buildCostDocSection(t)
	row := regexp.MustCompile(`^\|\s*(scrapling|agent|\*\*stage\*\*|\*\*both\*\*)\s*\|\s*([^|]*?)\s*\|\s*\*{0,2}([0-9,]+) B\*{0,2}\s*\|\s*\*{0,2}([0-9]+(?:\.[0-9])?) s\*{0,2}\s*\|`)

	var stage, artifact string
	perStage := map[string]int{}
	subtotals, total := map[string]int64{}, map[string]int64{}
	subtotalsNs, totalNs := map[string]int64{}, map[string]int64{}
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
		secs, err := strconv.ParseFloat(m[4], 64)
		if err != nil {
			t.Fatalf("unparsable time in %q: %v", line, err)
		}
		ns := int64(secs * 1000)
		switch stage {
		case "scrapling", "agent":
			perStage[stage]++
			subtotals["rows:"+stage] += bytes
			subtotalsNs["rows:"+stage] += ns
		case "**stage**":
			subtotals["stated:"+artifactKey(artifact)] = bytes
			subtotalsNs["stated:"+artifactKey(artifact)] = ns
		case "**both**":
			total["stated"] = bytes
			totalNs["stated"] = ns
		}
	}

	for _, name := range []string{"scrapling", "agent"} {
		if perStage[name] < 3 {
			t.Fatalf("expected the byte inventory to list at least 3 %s rows, parsed %d", name, perStage[name])
		}
		if got, want := subtotals["rows:"+name], subtotals["stated:"+name]; got != want {
			t.Errorf("%s subtotal states %d B but its rows sum to %d B", name, want, got)
		}
		// Rows are rounded to a tenth of a second, so the sum of the printed
		// rows and the printed subtotal may differ inside the rounding.
		if got, want := subtotalsNs["rows:"+name], subtotalsNs["stated:"+name]; got < want-2000 || got > want+2000 {
			t.Errorf("%s subtotal states %d ms but its rows sum to %d ms", name, want, got)
		}
	}
	if got, want := subtotals["rows:scrapling"]+subtotals["rows:agent"], total["stated"]; got != want {
		t.Errorf("the `both` total states %d B but the stage subtotals sum to %d B", want, got)
	}
	if got, want := subtotalsNs["rows:scrapling"]+subtotalsNs["rows:agent"], totalNs["stated"]; got < want-2000 || got > want+2000 {
		t.Errorf("the `both` total states %d ms but the stage subtotals sum to %d ms", want, got)
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

func TestBuildCostDoc_RecordsMeasuredColdBuildTime(t *testing.T) {
	// The audit of #2053 rejected the section while the post-change cold build
	// read `not measured` for its wall clock and its byte total was a sum of
	// advertised artifact sizes. Both halves are now measured together, so the
	// total row must carry a real time next to a real byte count.
	section := buildCostDocSection(t)
	if strings.Contains(section, "not measured") {
		t.Error("the cold build is measured; a `not measured` cell means the recorded measurement was dropped")
	}

	total := regexp.MustCompile(`(?m)^\|\s*\*\*both\*\*\s*\|[^|]*\|\s*\*{0,2}([0-9,]+) B\*{0,2}\s*\|\s*\*{0,2}([0-9]+(?:\.[0-9])?) s\*{0,2}\s*\|`)
	m := total.FindStringSubmatch(section)
	if m == nil {
		t.Fatal("§Measuring image build cost must state the grand total as `<bytes> B | <seconds> s`")
	}
	bytes, err := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64)
	if err != nil {
		t.Fatalf("unparsable total byte count %q: %v", m[1], err)
	}
	if bytes < 100_000_000 {
		t.Errorf("the cold-build total reads %d B — too small to be the full transfer", bytes)
	}
	seconds, err := strconv.ParseFloat(m[2], 64)
	if err != nil {
		t.Fatalf("unparsable total time %q: %v", m[2], err)
	}
	if seconds < 60 {
		t.Errorf("the cold-build total reads %v s — a full cold build takes minutes, this looks derived", seconds)
	}

	for _, line := range strings.Split(section, "\n") {
		if !strings.Contains(line, "After") {
			continue
		}
		for _, claim := range []string{"? ", "TBD", "unknown", "n/a"} {
			if strings.Contains(line, claim) {
				t.Errorf("the `After` row must be measured, not placholder text: %q", line)
			}
		}
	}
}
