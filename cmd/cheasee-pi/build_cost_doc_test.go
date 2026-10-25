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

// endToEndSection returns the `### End-to-end cache-pruned build` subsection,
// which owns the Docker-run measurement. Scoping matters: the replay totals live
// in the same `##` section, so a whole-section check cannot tell a run's bytes
// from a proxy run's.
func endToEndSection(t *testing.T) string {
	t.Helper()
	section := buildCostDocSection(t)
	const heading = "### End-to-end cache-pruned build"
	i := strings.Index(section, heading)
	if i < 0 {
		t.Fatal("docs/development.md must keep the `" + heading + "` subsection — it is where the Docker run is recorded")
	}
	rest := section[i+len(heading):]
	if j := strings.Index(rest, "\n### "); j >= 0 {
		rest = rest[:j]
	}
	return heading + rest
}

func TestBuildCostDoc_EndToEndTransferIsWireCaptured(t *testing.T) {
	// The first audit of #2053 rejected this subsection because its `end-to-end`
	// row carried the counting-proxy replay's bytes: a proxy run on another host
	// never pulls the base image, commits a layer or runs dpkg, so quoting it as
	// the Docker run's transfer left the download-volume criterion unmeasured.
	// The run's own transfer now comes from the NIC counter the `docker` job wraps
	// the build in (`scripts/net-bytes.sh`), and the replay may not stand in for it.
	run := endToEndSection(t)

	for _, replayOnly := range []string{"914,692,293"} {
		if strings.Contains(run, replayOnly) {
			t.Errorf("the end-to-end subsection must not quote %q: the replay's bytes are not this build's transfer", replayOnly)
		}
	}
	flat := flatSection(run)
	for _, want := range []string{
		"scripts/net-bytes.sh", // the instrument that produced the transfer
		"build-cost wire",      // and the label it prints
		"not back-filled",      // a replay figure may not be pasted into the row
		"0 cache hits",         // the row is a cache-pruned build or it is not the criterion
	} {
		if !strings.Contains(flat, want) {
			t.Errorf("§End-to-end cache-pruned build must contain %q", want)
		}
	}

	row := regexp.MustCompile(`(?m)^\|\s*\*{0,2}end-to-end\*{0,2}\s*\|([^|]*)\|([^|]*)\|\s*\*{0,2}([0-9]+(?:\.[0-9])?) s\*{0,2}\s*\|`)
	m := row.FindStringSubmatch(run)
	if m == nil {
		t.Fatal("§End-to-end cache-pruned build must record the run as an `end-to-end` row of `<environment> | <transfer> | <seconds> s`")
	}
	env, transfer, seconds := m[1], strings.TrimSpace(m[2]), m[3]
	if !strings.Contains(env, "net-bytes.sh") {
		t.Errorf("the end-to-end row must name the instrument behind its transfer, got environment %q", env)
	}
	// The row is the claim; prose elsewhere in the subsection may explain why the
	// replay is not used, but a cell may not source its number from it.
	for _, cell := range []string{env, transfer} {
		for _, replayOnly := range []string{"counting proxy", "counting-proxy", "replay"} {
			if strings.Contains(strings.ToLower(cell), replayOnly) {
				t.Errorf("the end-to-end row must not source a cell from the replay (cell %q names %q)", strings.TrimSpace(cell), replayOnly)
			}
		}
	}
	if !regexp.MustCompile(`^[0-9,]+ B$`).MatchString(transfer) {
		t.Errorf("the transfer cell must read a wire byte count captured by the run's own NIC counter, got %q", transfer)
	}
	// The cell is only traceable if the counter's own output is quoted next to it:
	// the row may not carry a number the doc cannot point back to a run's log line.
	bare := strings.TrimSuffix(strings.ReplaceAll(transfer, ",", ""), " B")
	if counter := "build-cost wire rx=" + bare + " B"; !strings.Contains(flat, counter) {
		t.Errorf("§End-to-end cache-pruned build must quote the counter's line %q behind the row's %q", counter, transfer)
	}
	secs, err := strconv.ParseFloat(seconds, 64)
	if err != nil {
		t.Fatalf("unparsable end-to-end time %q: %v", seconds, err)
	}
	if secs < 60 {
		t.Errorf("the end-to-end elapsed time reads %v s — a cache-pruned build takes minutes, this looks derived", secs)
	}
}

func TestBuildCostDoc_WireCounterIsWiredIntoTheDockerJob(t *testing.T) {
	// The counter only exists if the job that runs the cache-pruned build wraps
	// it: the doc, the script and the workflow have to agree on one label, and the
	// delta has to print even when the build fails (`if: always()`), otherwise the
	// transfer of a broken run is lost exactly when it matters.
	doc := flatSection(buildCostDocSection(t))
	if !strings.Contains(doc, "scripts/net-bytes.sh") {
		t.Error("§Measuring image build cost must name scripts/net-bytes.sh as the end-to-end transfer instrument")
	}

	script, err := os.ReadFile(filepath.Join("..", "..", "scripts", "net-bytes.sh"))
	if err != nil {
		t.Fatalf("scripts/net-bytes.sh must exist — it is the wire-byte instrument: %v", err)
	}
	const label = "build-cost wire"
	if !strings.Contains(string(script), label) {
		t.Errorf("scripts/net-bytes.sh must print the %q label the doc quotes", label)
	}
	if !strings.Contains(doc, label) {
		t.Errorf("docs/development.md must quote the %q label so the recorded number is traceable to its instrument", label)
	}

	workflow, err := os.ReadFile(filepath.Join("..", "..", ".github", "workflows", "tests.yml"))
	if err != nil {
		t.Fatalf("reading .github/workflows/tests.yml: %v", err)
	}
	before := strings.Index(string(workflow), "net-bytes.sh snapshot")
	build := strings.Index(string(workflow), "Prime dogfooding test image")
	delta := strings.Index(string(workflow), "net-bytes.sh delta")
	if before < 0 || build < 0 || delta < 0 {
		t.Fatalf("the `docker` job must snapshot the counters before the cache-pruned build and diff them after it (snapshot=%d build=%d delta=%d)", before, build, delta)
	}
	if !(before < build && build < delta) {
		t.Error("the counter must bracket the cache-pruned build: snapshot before the build step, delta after it")
	}
	tail := string(workflow)[build:]
	always := strings.Index(tail, "if: always()")
	if always < 0 || always > strings.Index(tail, "net-bytes.sh delta") {
		t.Error("the delta step must run with `if: always()` — a failed build still spends its downloads")
	}
}
