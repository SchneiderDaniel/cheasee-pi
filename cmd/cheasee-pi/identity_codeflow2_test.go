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

func TestCodeflowBoundPort_errorsFallThrough(t *testing.T) {
	for _, out := range []struct {
		name    string
		output  []byte
		cmdErr  error
		wantErr bool
	}{
		{"docker fails", nil, fmt.Errorf("container stopped"), true},
		{"empty output", nil, nil, true},
	} {
		t.Run(out.name, func(t *testing.T) {
			stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
				return &mockCmd{outputFn: func() ([]byte, error) { return out.output, out.cmdErr }}
			})
			_, err := codeflowBoundPort(context.Background(), filepath.Join(t.TempDir(), "ws"))
			if out.wantErr && err == nil {
				t.Fatal("expected an error (caller falls back to derive+probe)")
			}
			if !out.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// ──────────────────────────────────────────────
// stripEnvKeys (env hygiene for the derived identity)
// ──────────────────────────────────────────────

func TestStripEnvKeys(t *testing.T) {
	env := []string{"A=1", "B=2", "A=3", "C=4"}
	got := stripEnvKeys(env, "A")
	want := []string{"B=2", "C=4"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("stripEnvKeys(env, A) = %v, want %v", got, want)
	}
	if len(stripEnvKeys(env, "A", "B", "C")) != 0 {
		t.Errorf("stripping all keys must empty the env, got %v", stripEnvKeys(env, "A", "B", "C"))
	}
}

// ──────────────────────────────────────────────
// UI host port (uiHostPort / uiContainerName / uiBoundPort)
// ──────────────────────────────────────────────

func TestUiHostPort_derivedDeterministicInRange(t *testing.T) {
	t.Setenv("PI_UI_PORT", "")
	root := filepath.Join(t.TempDir(), "ws")
	p1, err := uiHostPort(root)
	if err != nil {
		t.Fatalf("uiHostPort: %v", err)
	}
	p2, err := uiHostPort(root)
	if err != nil {
		t.Fatal(err)
	}
	if p1 != p2 {
		t.Errorf("derived UI port must be deterministic per repo: %s vs %s", p1, p2)
	}
	n, err := strconv.Atoi(p1)
	if err != nil || n < uiPortBase || n >= uiPortBase+uiPortRange {
		t.Errorf("derived UI port must be in [9500, 10523], got %q", p1)
	}
}

func TestUiHostPort_bandDisjointFromCodeflow(t *testing.T) {
	// The two sidecars of one workspace must never collide: the UI band starts
	// at/above the first port past CodeFlow's [8470, 9493].
	if uiPortBase < codeflowPortBase+codeflowPortRange {
		t.Errorf("UI band must start at/above %d, got %d", codeflowPortBase+codeflowPortRange, uiPortBase)
	}
	// Power-of-two width → 2³² mod range == 0 → no FNV-1a modulo skew.
	if uiPortRange&(uiPortRange-1) != 0 {
		t.Errorf("uiPortRange must be a power of two, got %d", uiPortRange)
	}
	// Stay below the Linux ephemeral floor so a derived port is never one.
	if uiPortBase+uiPortRange > 32768 {
		t.Errorf("UI band top %d must stay below the 32768 ephemeral floor", uiPortBase+uiPortRange)
	}
}

func TestUiHostPort_twoRootsDistinctPorts(t *testing.T) {
	t.Setenv("PI_UI_PORT", "")
	rootA := filepath.Join(t.TempDir(), "repo-alpha")
	rootB := filepath.Join(t.TempDir(), "repo-beta")
	pa, err := uiHostPort(rootA)
	if err != nil {
		t.Fatal(err)
	}
	pb, err := uiHostPort(rootB)
	if err != nil {
		t.Fatal(err)
	}
	if pa == pb {
		t.Errorf("two distinct repos must resolve to distinct UI ports, both %s", pa)
	}
}

func TestUiHostPort_envOverrideWins(t *testing.T) {
	t.Setenv("PI_UI_PORT", "9000")
	got, err := uiHostPort(filepath.Join(t.TempDir(), "ws"))
	if err != nil {
		t.Fatal(err)
	}
	if got != "9000" {
		t.Errorf("env PI_UI_PORT must win over derivation, got %s", got)
	}
}

func TestUiHostPort_settingsWinsOverEnv(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"docker": {"uiPort": "9100"}}`)
	t.Setenv("PI_UI_PORT", "9000")
	got, err := uiHostPort(workdir)
	if err != nil {
		t.Fatal(err)
	}
	if got != "9100" {
		t.Errorf("settings docker.uiPort must win over env, got %s", got)
	}
}

func TestUiHostPort_occupiedFallsBackToNextFree(t *testing.T) {
	t.Setenv("PI_UI_PORT", "")
	root := filepath.Join(t.TempDir(), "ws")
	start := uiPortBase + int(fnv32(repoSlug(root))%uiPortRange)
	if start == uiPortBase+uiPortRange-1 {
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

	got, err := uiHostPort(root)
	if err != nil {
		t.Fatal(err)
	}
	n, _ := strconv.Atoi(got)
	if n != start+1 {
		t.Errorf("occupied derived UI port must fall back to the next free (%d), got %d", start+1, n)
	}
}
