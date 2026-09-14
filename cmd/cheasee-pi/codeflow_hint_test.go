package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// CodeFlow stderr hint (printCodeFlowHint): the URL line stays byte-identical
// to the historic two print sites, followed by one description-only trailer.
// Kept in its own file to stay under the repo's per-file line gate.
// ──────────────────────────────────────────────

func TestPrintCodeFlowHint_twoLineContract(t *testing.T) {
	stderr := testutil.CaptureStderr(t, func() { printCodeFlowHint("8891") })

	lines := strings.Split(strings.TrimRight(stderr, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("hint must print exactly 2 lines, got %d: %q", len(lines), stderr)
	}
	if want := "  ℹ CodeFlow: http://localhost:8891/?repo=local/workspace&run=1"; lines[0] != want {
		t.Errorf("line 1 = %q, want %q", lines[0], want)
	}
	if !strings.HasPrefix(lines[1], "  ℹ ") {
		t.Errorf("line 2 must carry the '  ℹ ' prefix, got %q", lines[1])
	}
	for _, want := range []string{"Optional browser sidecar", "docs/daily-usage.md"} {
		if !strings.Contains(lines[1], want) {
			t.Errorf("line 2 must contain %q, got %q", want, lines[1])
		}
	}
}

func TestPrintCodeFlowHint_portBoundaries(t *testing.T) {
	// Derived range low/high plus the empty defensive boundary (no panic).
	for _, port := range []string{"8470", "9493", ""} {
		stderr := testutil.CaptureStderr(t, func() { printCodeFlowHint(port) })
		want := "http://localhost:" + port + "/?repo=local/workspace&run=1"
		if !strings.Contains(stderr, want) {
			t.Errorf("port %q: stderr must contain %q, got %q", port, want, stderr)
		}
	}
}

func TestRunUpE_codeflowHintBoundPortBranch(t *testing.T) {
	// codeflowBoundPort success (`docker port` publishes 8470) must route
	// through the shared helper: URL + trailer with the published port, and
	// the same port in the exec env.
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)
	inner := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "port" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("0.0.0.0:8891\n"), nil }}
		}
		return inner(ctx, name, arg...)
	})

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	if !strings.Contains(stderr, "http://localhost:8891/?repo=local/workspace&run=1") {
		t.Errorf("bound-port branch must print the published URL, got: %q", stderr)
	}
	if !strings.Contains(stderr, "Optional browser sidecar") {
		t.Errorf("bound-port branch must print the trailer, got: %q", stderr)
	}
	if got := exec.env["CODEFLOW_PORT"]; got != "8891" {
		t.Errorf("exec env CODEFLOW_PORT = %q, want 8891", got)
	}
}

// ──────────────────────────────────────────────
// Drift + docs-sync guards (source-level)
// ──────────────────────────────────────────────

func TestCodeFlowHint_singleSourceStatic(t *testing.T) {
	// The URL literal must live only in codeflow_hint.go; the two up_run.go
	// branches must not drift back to duplicated prints.
	upRun, err := os.ReadFile("up_run.go")
	if err != nil {
		t.Fatalf("read up_run.go: %v", err)
	}
	if strings.Contains(string(upRun), "ℹ CodeFlow: http://localhost:") {
		t.Error("up_run.go must not contain the CodeFlow URL literal — call printCodeFlowHint instead")
	}
	hint, err := os.ReadFile("codeflow_hint.go")
	if err != nil {
		t.Fatalf("read codeflow_hint.go: %v", err)
	}
	if !strings.Contains(string(hint), "ℹ CodeFlow: http://localhost:") {
		t.Error("codeflow_hint.go must own the CodeFlow URL literal")
	}
}

func TestDailyUsageDoc_codeflowHintTrailer(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "daily-usage.md"))
	if err != nil {
		t.Fatalf("reading docs/daily-usage.md: %v", err)
	}
	lines := strings.Split(string(data), "\n")
	urlLine := -1
	for i, l := range lines {
		if strings.Contains(l, "ℹ CodeFlow: http://localhost:8891/?repo=local/workspace&run=1") {
			urlLine = i
			break
		}
	}
	if urlLine == -1 {
		t.Fatal("daily-usage.md CLI example must show the CodeFlow URL line")
	}
	if urlLine+1 >= len(lines) || !strings.Contains(lines[urlLine+1], "Optional browser sidecar") {
		t.Error("daily-usage.md CLI example must follow the CodeFlow URL with the hint trailer line")
	}
}
