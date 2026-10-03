package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// UI stderr hint (printUIHint) + the runUpE UI URL branches. Kept in its own
// file to stay under the repo's per-file line gate.
// ──────────────────────────────────────────────

func TestPrintUIHint_urlLine(t *testing.T) {
	stderr := testutil.CaptureStderr(t, func() { printUIHint("9713") })

	lines := strings.Split(strings.TrimRight(stderr, "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("hint must print exactly 1 line, got %d: %q", len(lines), stderr)
	}
	if want := "  ℹ UI: http://127.0.0.1:9713"; lines[0] != want {
		t.Errorf("line 1 = %q, want %q", lines[0], want)
	}
}

func TestPrintUIHint_neverLocalhost(t *testing.T) {
	// The compose host-side bind is IPv4-loopback only; a `localhost` URL fails
	// on hosts where localhost resolves to ::1 first.
	for _, port := range []string{"9500", "10523", ""} {
		stderr := testutil.CaptureStderr(t, func() { printUIHint(port) })
		if strings.Contains(stderr, "localhost") {
			t.Errorf("port %q: hint must use the literal 127.0.0.1, never localhost, got %q", port, stderr)
		}
		if !strings.Contains(stderr, "http://127.0.0.1:"+port) {
			t.Errorf("port %q: stderr must contain the literal IPv4 URL, got %q", port, stderr)
		}
	}
}

func TestRunUpE_UIHintBoundPortBranch(t *testing.T) {
	// `docker port` publishes distinct ports for codeflow and ui: each hint
	// must print its own published port, and the UI port must reach the exec
	// env as PI_UI_PORT so the in-session footer link agrees with the hint.
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)
	inner := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "port" {
			if arg[1] == uiContainerName(root) {
				return &mockCmd{outputFn: func() ([]byte, error) { return []byte("127.0.0.1:9713\n"), nil }}
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("0.0.0.0:8891\n"), nil }}
		}
		return inner(ctx, name, arg...)
	})

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	if !strings.Contains(stderr, "http://127.0.0.1:9713") {
		t.Errorf("bound-port branch must print the published UI URL, got: %q", stderr)
	}
	if !strings.Contains(stderr, "http://localhost:8891/?repo=local/workspace&run=1") {
		t.Errorf("CodeFlow URL must still print, got: %q", stderr)
	}
	if got := exec.env["PI_UI_PORT"]; got != "9713" {
		t.Errorf("exec env PI_UI_PORT = %q, want 9713", got)
	}
}

func TestRunUpE_UIHintFallback(t *testing.T) {
	// `docker port` yields nothing (first up / stopped sidecar) → the hint
	// comes from the derived+probed port, and the same value reaches the env.
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	// Hermetic: an inherited PI_UI_PORT would short-circuit uiHostPort's
	// derive+probe and make the fallback assertion env-dependent.
	t.Setenv("PI_UI_PORT", "")
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})
	want, err := uiHostPort(root)
	if err != nil {
		t.Fatalf("uiHostPort: %v", err)
	}
	if !strings.Contains(stderr, "http://127.0.0.1:"+want) {
		t.Errorf("fallback branch must print the derived UI URL (port %s), got: %q", want, stderr)
	}
	if got := exec.env["PI_UI_PORT"]; got != want {
		t.Errorf("exec env PI_UI_PORT = %q, want the printed %q", got, want)
	}
}

func TestRunUpE_UIHintResolutionFailure(t *testing.T) {
	// Probe exhaustion must fail closed: no UI URL line, and PI_UI_PORT is
	// forwarded EMPTY (defined-but-empty is the extension's "CLI ran, port
	// unavailable → suppress the footer link" signal — leaving it absent would
	// make the extension derive a port it does not own). CodeFlow (off the
	// probe via CODEFLOW_PORT) is unaffected.
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	t.Setenv("CODEFLOW_PORT", "9000")
	// Hermetic: force the derive+probe path regardless of the ambient env.
	t.Setenv("PI_UI_PORT", "")
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)
	saved := portProbe
	portProbe = func(_ int) error { return fmt.Errorf("in use") }
	t.Cleanup(func() { portProbe = saved })

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})
	if strings.Contains(stderr, "http://127.0.0.1:") {
		t.Errorf("resolution failure must not print a UI URL, got: %q", stderr)
	}
	if !strings.Contains(stderr, "⚠ UI port:") {
		t.Errorf("resolution failure must surface the ⚠ UI port line, got: %q", stderr)
	}
	if got, ok := exec.env["PI_UI_PORT"]; !ok || got != "" {
		t.Errorf("exec env must carry an empty PI_UI_PORT on resolution failure, got %q (present=%v) in %v", got, ok, exec.env)
	}
	if !strings.Contains(stderr, "http://localhost:9000") {
		t.Errorf("CodeFlow hint must be unaffected, got: %q", stderr)
	}
}

// ──────────────────────────────────────────────
// Static + docs guards
// ──────────────────────────────────────────────

func TestUIHint_singleSourceStatic(t *testing.T) {
	// The URL literal must live only in ui_hint.go; the two up_run.go branches
	// must not drift back to duplicated prints.
	upRun, err := os.ReadFile("up_run.go")
	if err != nil {
		t.Fatalf("read up_run.go: %v", err)
	}
	if strings.Contains(string(upRun), "http://127.0.0.1:") {
		t.Error("up_run.go must not contain the UI URL literal — call printUIHint instead")
	}
	if !strings.Contains(string(upRun), "PI_UI_PORT") {
		t.Error("up_run.go must forward the resolved UI port as PI_UI_PORT to the exec env")
	}
	hint, err := os.ReadFile("ui_hint.go")
	if err != nil {
		t.Fatalf("read ui_hint.go: %v", err)
	}
	if !strings.Contains(string(hint), "http://127.0.0.1:") {
		t.Error("ui_hint.go must own the UI URL literal")
	}
}

func TestDailyUsageDoc_uiHint(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "daily-usage.md"))
	if err != nil {
		t.Fatalf("reading docs/daily-usage.md: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "http://127.0.0.1:") {
		t.Error("daily-usage.md §UI must show the literal 127.0.0.1 URL")
	}
	for _, want := range []string{"9500", "10523", "docker.uiPort", "PI_UI_PORT", "UI · CodeFlow"} {
		if !strings.Contains(content, want) {
			t.Errorf("daily-usage.md §UI must mention %q", want)
		}
	}
	if !strings.Contains(content, "PI_UI_PORT") || !strings.Contains(content, "forwarded") {
		t.Error("daily-usage.md §UI must state that PI_UI_PORT is forwarded into the session")
	}
	// Contract revision (audit finding): the footer group is OSC 8 emission;
	// the host terminal is the opener, and the in-container openUrl path is
	// documented as a non-goal. Pin the wording so the contract cannot silently
	// drift back to "clicking opens a browser in-container".
	for _, want := range []string{"OSC 8", "terminal", "not routable", "control characters", "xdg-open"} {
		if !strings.Contains(strings.ToLower(content), strings.ToLower(want)) {
			t.Errorf("daily-usage.md §UI must document the OSC 8 emission contract (%q)", want)
		}
	}
	// Suppression contract (audit finding): CLI resolution failure forwards an
	// empty PI_UI_PORT and the footer drops the UI link, while an absent key
	// (no CLI) keeps the derived fallback.
	for _, want := range []string{"empty", "suppresses", "started outside the CLI"} {
		if !strings.Contains(content, want) {
			t.Errorf("daily-usage.md §UI must document the resolution-failure suppression (%q)", want)
		}
	}
}
