package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestCodeflowHostPort_envOverrideWins(t *testing.T) {
	t.Setenv("CODEFLOW_PORT", "9000")
	got, err := codeflowHostPort(filepath.Join(t.TempDir(), "ws"))
	if err != nil {
		t.Fatal(err)
	}
	if got != "9000" {
		t.Errorf("env CODEFLOW_PORT must win over derivation, got %s", got)
	}
}

func TestCodeflowHostPort_settingsWinsOverEnv(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"docker": {"codeflowPort": "9100"}}`)
	t.Setenv("CODEFLOW_PORT", "9000")
	got, err := codeflowHostPort(workdir)
	if err != nil {
		t.Fatal(err)
	}
	if got != "9100" {
		t.Errorf("settings docker.codeflowPort must win over env, got %s", got)
	}
}

func TestCodeflowHostPort_occupiedFallsBackToNextFree(t *testing.T) {
	// Hermetic: an inherited CODEFLOW_PORT would skip the probe entirely.
	t.Setenv("CODEFLOW_PORT", "")
	root := filepath.Join(t.TempDir(), "ws")
	start := codeflowPortBase + int(fnv32(repoSlug(root))%codeflowPortRange)
	if start == codeflowPortBase+codeflowPortRange-1 {
		t.Skip("derived port at range end — no fallback slot; covered by exhaustion test")
	}
	saved := portProbe
	portProbe = func(p int) error {
		if p == start {
			return fmt.Errorf("in use")
		}
		return nil
	}
	t.Cleanup(func() { portProbe = saved })

	got, err := codeflowHostPort(root)
	if err != nil {
		t.Fatal(err)
	}
	n, _ := strconv.Atoi(got)
	if n != start+1 {
		t.Errorf("occupied derived port must fall back to the next free (%d), got %d", start+1, n)
	}
}

func TestExplicitCodeflowPort_settingsBeatsEnv(t *testing.T) {
	// Settings docker.codeflowPort > env CODEFLOW_PORT; both absent → ""
	// (the derived/probed port is excluded from the drift check).
	root := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, root, `{"docker": {"codeflowPort": "9100"}}`)
	t.Setenv("CODEFLOW_PORT", "9000")
	if got := explicitCodeflowPort(root); got != "9100" {
		t.Errorf("settings must win over env, got %q", got)
	}

	envOnly := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, envOnly, `{}`)
	t.Setenv("CODEFLOW_PORT", "9000")
	if got := explicitCodeflowPort(envOnly); got != "9000" {
		t.Errorf("env must win over derivation, got %q", got)
	}

	t.Setenv("CODEFLOW_PORT", "")
	if got := explicitCodeflowPort(envOnly); got != "" {
		t.Errorf("both absent must yield \"\" (derived sentinel), got %q", got)
	}
}

func TestCodeflowHostPort_rangeExhaustedFailsClosed(t *testing.T) {
	// Hermetic: an inherited CODEFLOW_PORT would return before probing.
	t.Setenv("CODEFLOW_PORT", "")
	saved := portProbe
	portProbe = func(p int) error { return fmt.Errorf("in use") }
	t.Cleanup(func() { portProbe = saved })

	_, err := codeflowHostPort(filepath.Join(t.TempDir(), "ws"))
	if err == nil {
		t.Fatal("range exhaustion must fail closed with an error")
	}
	if !strings.Contains(err.Error(), "CODEFLOW_PORT") {
		t.Errorf("error must name the remedy (CODEFLOW_PORT), got %v", err)
	}
}

// codeflowBoundPort (`docker port` queries the sidecar's live bind)
// ──────────────────────────────────────────────

func TestCodeflowBoundPort_queriesDockerPort(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ws")
	var gotName, gotArg, gotProto string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "port" {
			gotName, gotArg, gotProto = name, arg[1], arg[2]
		}
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("0.0.0.0:8938\n"), nil }}
	})
	got, err := codeflowBoundPort(context.Background(), root)
	if err != nil {
		t.Fatalf("codeflowBoundPort: %v", err)
	}
	if got != "8938" {
		t.Errorf("must return the published host port, got %q", got)
	}
	if gotName != "docker" || gotArg != codeflowContainerName(root) || gotProto != "8470/tcp" {
		t.Errorf("must query the sidecar container port, got docker %q arg %q proto %q", gotName, gotArg, gotProto)
	}
}

func TestCodeflowBoundPort_ipv6BindParsed(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("[::]:8938\n"), nil }}
	})
	got, err := codeflowBoundPort(context.Background(), filepath.Join(t.TempDir(), "ws"))
	if err != nil {
		t.Fatalf("codeflowBoundPort: %v", err)
	}
	if got != "8938" {
		t.Errorf("ipv6 bind must parse the host port, got %q", got)
	}
}

func TestCodeflowBoundPort_loopbackBindParsed(t *testing.T) {
	// The pinned compose mapping publishes "127.0.0.1:<port>" — the exact
	// shape `docker port` reports after the loopback pin; the last-colon
	// parse must return the port.
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("127.0.0.1:8938\n"), nil }}
	})
	got, err := codeflowBoundPort(context.Background(), filepath.Join(t.TempDir(), "ws"))
	if err != nil {
		t.Fatalf("codeflowBoundPort: %v", err)
	}
	if got != "8938" {
		t.Errorf("loopback bind must parse the host port, got %q", got)
	}
}
