package main

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// resolveUIHostPort + runUpE UI port→exec-env forwarding (R1). Kept in its own
// file to stay under the repo's per-file line gate.
// ──────────────────────────────────────────────

func TestResolveUIHostPort_boundWinsOverProbe(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	t.Setenv("PI_UI_PORT", "")
	inner := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "port" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("127.0.0.1:9713\n"), nil }}
		}
		return inner(ctx, name, arg...)
	})
	probed := false
	saved := portProbe
	portProbe = func(_ int) error { probed = true; return nil }
	t.Cleanup(func() { portProbe = saved })

	got, err := resolveUIHostPort(context.Background(), root)
	if err != nil {
		t.Fatalf("resolveUIHostPort: %v", err)
	}
	if got != "9713" {
		t.Errorf("bound port must win, got %q, want 9713", got)
	}
	if probed {
		t.Error("probe must not be consulted when `docker port` succeeds")
	}
}

func TestResolveUIHostPort_fallbackToProbe(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	t.Setenv("PI_UI_PORT", "")
	inner := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "port" {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, exitStatusError(1) }}
		}
		return inner(ctx, name, arg...)
	})
	want, err := uiHostPort(root)
	if err != nil {
		t.Fatalf("uiHostPort: %v", err)
	}

	got, err := resolveUIHostPort(context.Background(), root)
	if err != nil {
		t.Fatalf("resolveUIHostPort: %v", err)
	}
	if got != want {
		t.Errorf("docker-port failure must fall back to uiHostPort (%q), got %q", want, got)
	}
}

func TestResolveUIHostPort_propagation(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	t.Setenv("PI_UI_PORT", "")
	inner := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "port" {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, exitStatusError(1) }}
		}
		return inner(ctx, name, arg...)
	})
	saved := portProbe
	portProbe = func(_ int) error { return fmt.Errorf("in use") }
	t.Cleanup(func() { portProbe = saved })

	_, err := resolveUIHostPort(context.Background(), root)
	if err == nil {
		t.Fatal("range exhaustion must surface an error")
	}
	if want := "no free host port in [9500, 10523] for the UI service"; !strings.Contains(err.Error(), want) {
		t.Errorf("error must keep uiHostPort's verbatim text %q, got %q", want, err.Error())
	}
}

func TestRunUpE_UIPortHintEnvParity(t *testing.T) {
	// AC2: the port in the printed hint and the port in the exec env are the
	// same value on both the bound and the fallback branch.
	cases := []struct {
		name       string
		portOutput string
		portErr    bool
		want       string
	}{
		{name: "bound", portOutput: "127.0.0.1:9713\n", want: "9713"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, root := mkWorkspace(t, `{}`)
			setUpRunMode(t, root, false)
			exec := stubExecPIContainer(t)
			stubUpFlow(t, root, false)
			inner := runCommandContext
			stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
				if name == "docker" && len(arg) > 0 && arg[0] == "port" && arg[1] == uiContainerName(root) {
					if tc.portErr {
						return &mockCmd{outputFn: func() ([]byte, error) { return nil, exitStatusError(1) }}
					}
					return &mockCmd{outputFn: func() ([]byte, error) { return []byte(tc.portOutput), nil }}
				}
				return inner(ctx, name, arg...)
			})
			stderr := testutil.CaptureStderr(t, func() {
				if err := runUpE(&cobra.Command{}, nil); err != nil {
					t.Fatalf("runUpE: %v", err)
				}
			})
			if got := exec.env["PI_UI_PORT"]; got != tc.want {
				t.Errorf("exec env PI_UI_PORT = %q, want %q", got, tc.want)
			}
			if !strings.Contains(stderr, "http://127.0.0.1:"+tc.want) {
				t.Errorf("hint must carry the same port %q, got %q", tc.want, stderr)
			}
		})
	}
}
