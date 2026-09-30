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
	// must print its own published port, and the UI port must NOT leak into
	// the exec env (no in-container consumer).
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
	if _, ok := exec.env["PI_UI_PORT"]; ok {
		t.Errorf("exec env must NOT carry PI_UI_PORT, got %v", exec.env)
	}
}

func TestRunUpE_UIHintFallback(t *testing.T) {
	// `docker port` yields nothing (first up / stopped sidecar) → the hint
	// comes from the derived+probed port.
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)
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
}

func TestRunUpE_UIHintResolutionFailure(t *testing.T) {
	// Probe exhaustion must fail closed: no UI URL line, and the CodeFlow hint
	// (off the probe via CODEFLOW_PORT) is unaffected.
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	t.Setenv("CODEFLOW_PORT", "9000")
	stubExecPIContainer(t)
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
	for _, want := range []string{"9500", "10523", "docker.uiPort", "PI_UI_PORT"} {
		if !strings.Contains(content, want) {
			t.Errorf("daily-usage.md §UI must mention %q", want)
		}
	}
}
