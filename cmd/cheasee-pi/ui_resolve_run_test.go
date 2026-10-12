package main

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestRunUpE_UIPortBoundOverridesSettingsAndEnv(t *testing.T) {
	_, root := mkWorkspace(t, `{"docker":{"uiPort":"9600"}}`)
	setUpRunMode(t, root, false)
	t.Setenv("PI_UI_PORT", "9700")
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)
	inner := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "port" && arg[1] == uiContainerName(root) {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("127.0.0.1:9713\n"), nil }}
		}
		return inner(ctx, name, arg...)
	})

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})
	if got := exec.env["PI_UI_PORT"]; got != "9713" {
		t.Errorf("bound port must beat settings/env, got %q, want 9713", got)
	}
	if !strings.Contains(stderr, "http://127.0.0.1:9713") {
		t.Errorf("hint must print the bound port, got %q", stderr)
	}
}

func TestRunUpE_UIPortSettingsOverride(t *testing.T) {
	_, root := mkWorkspace(t, `{"docker":{"uiPort":"9600"}}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})
	if got := exec.env["PI_UI_PORT"]; got != "9600" {
		t.Errorf("settings docker.uiPort must win when unbound, got %q, want 9600", got)
	}
	if !strings.Contains(stderr, "http://127.0.0.1:9600") {
		t.Errorf("hint must print the settings port, got %q", stderr)
	}
}

func TestRunUpE_UIPortEnvOverride(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	t.Setenv("PI_UI_PORT", "9700")
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})
	if got := exec.env["PI_UI_PORT"]; got != "9700" {
		t.Errorf("host PI_UI_PORT must win when unbound, got %q, want 9700", got)
	}
	if !strings.Contains(stderr, "http://127.0.0.1:9700") {
		t.Errorf("hint must print the env port, got %q", stderr)
	}
}

func TestRunUpE_UIPortFailureLeavesCodeflowIntact(t *testing.T) {
	// UI probe exhaustion must not disturb the CodeFlow forwarding/hint.
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
	if got, ok := exec.env["CODEFLOW_PORT"]; !ok || got != "9000" {
		t.Errorf("CODEFLOW_PORT must survive UI failure, got %q (present=%v)", got, ok)
	}
	if !strings.Contains(stderr, "http://localhost:9000") {
		t.Errorf("CodeFlow hint must survive UI failure, got %q", stderr)
	}
	if got, ok := exec.env["PI_UI_PORT"]; ok {
		t.Errorf("PI_UI_PORT must be OMITTED on UI failure, got %q in %v", got, exec.env)
	}
	if got := exec.env["CHEASEE_UI_PORT_UNRESOLVED"]; got != "1" {
		t.Errorf("CHEASEE_UI_PORT_UNRESOLVED must be set on UI failure, got %q in %v", got, exec.env)
	}
}
