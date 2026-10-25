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

// flatSection collapses whitespace so a phrase that wraps across a line break
// still matches. Prose contracts go through it; table rows are matched
// line-anchored against the raw section.
func flatSection(section string) string { return strings.Join(strings.Fields(section), " ") }

func TestBuildCostDoc_RecordsBothScenarios(t *testing.T) {
	// #2053 turned on two separate mechanisms (cache mounts fix a re-run, the
	// scrapling stage + digest pins fix an evicted cache). A measurement section
	// that only quotes one number would hide which of the two it measured.
	flat := flatSection(buildCostDocSection(t))
	for _, want := range []string{
		"Fully cold",
		"Agent-layer invalidation",
		"docker buildx prune -af",
		"docker buildx du",
		"docker images --format",
		"--progress=plain",
		"scripts/measure-cold-build.sh", // the no-daemon half of the measurement
		"replay",                        // and it is named as one, not as the build
		"layer commit",                  // the costs a replay cannot observe
		"dpkg",
	} {
		if !strings.Contains(flat, want) {
			t.Errorf("docs/development.md §Measuring image build cost must contain %q", want)
		}
	}
}

func TestBuildCostDoc_ReplayRowsCarryBytesAndTime(t *testing.T) {
	// The rows are single observed transfers, so each one must carry a byte
	// count and an elapsed time — a table that drops back to advertised
	// artifact sizes, or to a byte-only inventory, is not the measurement.
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
	// The table is pasted from the script, so the script's own label for the
	// grand total is the one the doc has to carry: a total called "cold build
	// transfer" without the replay qualifier is read as an end-to-end build.
	const label = "cold build transfer (replay)"
	if !strings.Contains(section, label) {
		t.Errorf("the grand-total row must be labelled %q", label)
	}
	script, err := os.ReadFile(filepath.Join("..", "..", "scripts", "measure-cold-build.sh"))
	if err != nil {
		t.Fatalf("the documented measurement script must exist: %v", err)
	}
	if !strings.Contains(string(script), label) {
		t.Errorf("scripts/measure-cold-build.sh must print the same %q label the doc quotes", label)
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

func TestBuildCostDoc_EndToEndColdBuildIsRecordedOrPending(t *testing.T) {
	// The audit of #2053 rejected this section once because the after-number was
	// a replay: the Dockerfile's download steps re-run through a counting proxy,
	// which never pulls the base image, commits a layer or runs dpkg. That is a
	// lower bound, not the cold build. There are exactly two honest states for
	// the end-to-end figure, and both are accepted here so recording a real run
	// never needs a test edit:
	//
	//   - recorded: an `end-to-end` row with observed bytes and seconds;
	//   - pending: `not measured`, with the reason (no container runtime) and
	//     the commands that would produce it.
	//
	// What the test refuses is the third state the rejection found: a replay
	// total standing in for the end-to-end number.
	section := buildCostDocSection(t)

	if strings.Contains(section, "not measured") {
		flat := flatSection(section)
		for _, want := range []string{
			"container runtime", // why it is pending rather than "TBD"
			"docker buildx prune -af",
			"docker buildx du",
			"docker system df -v",
			"dpkg", // what a replay cannot observe — named next to the pending marker
			"layer commit",
			"replay",
		} {
			if !strings.Contains(flat, want) {
				t.Errorf("a `not measured` end-to-end figure must say %q: the gap has to name its reason and its procedure", want)
			}
		}
		return
	}

	row := regexp.MustCompile(`(?m)^\|\s*\*{0,2}end-to-end\*{0,2}\s*\|[^|]*\|\s*\*{0,2}([0-9,]+) B\*{0,2}\s*\|\s*\*{0,2}([0-9]+(?:\.[0-9])?) s\*{0,2}\s*\|`)
	m := row.FindStringSubmatch(section)
	if m == nil {
		t.Fatal("§Measuring image build cost must record the end-to-end cache-pruned build as an `end-to-end` row of `<bytes> B | <seconds> s` (or declare it `not measured`)")
	}
	bytes, err := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64)
	if err != nil {
		t.Fatalf("unparsable end-to-end byte count %q: %v", m[1], err)
	}
	if bytes < 100_000_000 {
		t.Errorf("the end-to-end total reads %d B — too small to be a full cold build", bytes)
	}
	seconds, err := strconv.ParseFloat(m[2], 64)
	if err != nil {
		t.Fatalf("unparsable end-to-end time %q: %v", m[2], err)
	}
	if seconds < 60 {
		t.Errorf("the end-to-end total reads %v s — a cache-pruned build takes minutes, this looks derived", seconds)
	}
}
