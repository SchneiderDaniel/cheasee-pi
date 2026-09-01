package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// runUpE CodeFlow exec-env forwarding tests (up.go Phase 3): the resolver's
// CODEFLOW_PORT must be visible inside the container so the in-session
// context-info hint matches the actually-bound sidecar port. Kept in their
// own file to stay under the repo's 800-line per-file gate.
// ──────────────────────────────────────────────

func TestRunUpE_codeflowPortFromSettingsReachesExecEnv(t *testing.T) {
	// Settings docker.codeflowPort must land in the exec env verbatim,
	// overriding host env and derivation.
	_, root := mkWorkspace(t, `{"docker": {"codeflowPort": "9100"}}`)
	setUpRunMode(t, root, false)
	t.Setenv("CODEFLOW_PORT", "9000")
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)
	testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})
	if got := exec.env["CODEFLOW_PORT"]; got != "9100" {
		t.Errorf("exec env must carry the settings docker.codeflowPort over env/derivation, got %q", got)
	}
}

func TestRunUpE_codeflowPortFromHostEnvReachesExecEnv(t *testing.T) {
	// A host CODEFLOW_PORT (previously filtered out of docker exec) must now
	// be forwarded into the container.
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	t.Setenv("CODEFLOW_PORT", "9000")
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)
	testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})
	if got := exec.env["CODEFLOW_PORT"]; got != "9000" {
		t.Errorf("exec env must carry the host CODEFLOW_PORT, got %q", got)
	}
}

func TestRunUpE_codeflowPortResolutionFailureLeavesEnvAbsent(t *testing.T) {
	// Probe exhaustion must fail closed: no CODEFLOW_PORT key in the exec env
	// (the extension falls back to its own derivation) and the existing
	// stderr warning still prints.
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
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
	if _, ok := exec.env["CODEFLOW_PORT"]; ok {
		t.Errorf("exec env must not carry CODEFLOW_PORT when resolution fails, got %v", exec.env)
	}
	if !strings.Contains(stderr, "CodeFlow port") {
		t.Errorf("resolution failure must still warn on stderr, got: %q", stderr)
	}
}