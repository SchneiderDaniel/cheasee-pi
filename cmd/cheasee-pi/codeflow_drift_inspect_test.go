package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestInspectCodeflowSpec_failureWraps(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ws")
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" {
			return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon gone") }}
		}
		return &mockCmd{}
	})
	_, err := inspectCodeflowSpec(context.Background(), root)
	if err == nil || !strings.Contains(err.Error(), "docker inspect") {
		t.Fatalf("inspect failure must wrap as 'docker inspect: ...', got %v", err)
	}
}

func TestInspectCodeflowSpec_noSuchObjectIsMissing(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ws")
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" {
			return &mockCmd{combinedFn: func() ([]byte, error) {
				return []byte("Error: No such object: codeflow-ws"), exitStatusError(1)
			}}
		}
		return &mockCmd{}
	})
	spec, err := inspectCodeflowSpec(context.Background(), root)
	if err != nil {
		t.Fatalf("missing sidecar must be a condition, not a failure: %v", err)
	}
	if !spec.Missing {
		t.Error("'No such object' must read as the missing drift condition")
	}
}

func TestInspectCodeflowSpec_malformedJSONErrors(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ws")
	stubCodeflowInspect(t, "{not json", nil)
	_, err := inspectCodeflowSpec(context.Background(), root)
	if err == nil || !strings.Contains(err.Error(), "parse docker inspect") {
		t.Fatalf("malformed JSON must wrap as 'parse docker inspect: ...', got %v", err)
	}
}

// ──────────────────────────────────────────────
// Phase 3: warnIfCodeflowDrift compare + messaging
// ──────────────────────────────────────────────

// assertCodeflowRecoveryCommands asserts stderr carries the exact recovery
// command pair every stale warning must print.

func assertCodeflowRecoveryCommands(t *testing.T, stderr string) {
	t.Helper()
	for _, want := range []string{"cheasee-pi start --build", "cheasee-pi down", "cheasee-pi start"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("warning must print the exact recovery command %q, got: %q", want, stderr)
		}
	}
}

func TestWarnIfCodeflowDrift_currentSpecSilent(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)
	spec, err := codeflowSpecHash(root, cacheDir)
	if err != nil {
		t.Fatal(err)
	}

	stubCodeflowInspect(t, mustJSON(codeflowInspectDoc(cacheDir, spec, "")), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if stderr != "" {
		t.Errorf("matching sidecar must warn nothing, got: %q", stderr)
	}
}

func TestWarnIfCodeflowDrift_staleConfigMountWarns(t *testing.T) {
	// Newer CLI extracted a new cache dir; the running sidecar still mounts
	// the old one (old stamp rides along).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	oldCache := filepath.Join(t.TempDir(), "cheasee-pi", "0.54.0")
	writeCodeflowCacheDir(t, oldCache)
	oldSpec, _ := codeflowSpecHash(root, oldCache)

	stubCodeflowInspect(t, mustJSON(codeflowInspectDoc(oldCache, oldSpec, "")), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "stale") {
		t.Errorf("warning must say the sidecar is stale, got: %q", stderr)
	}
	if !strings.Contains(stderr, "config.json") {
		t.Errorf("warning must name the drifted config.json mount, got: %q", stderr)
	}
	if !strings.Contains(stderr, "cheasee-pi start --build") || !strings.Contains(stderr, "cheasee-pi down") {
		t.Errorf("warning must print BOTH recovery commands, got: %q", stderr)
	}
}

func TestWarnIfCodeflowDrift_portChangedWarns(t *testing.T) {
	// Settings now pin 9100; the live sidecar still publishes 9000.
	_, root := mkWorkspace(t, `{"docker": {"codeflowPort": "9100"}}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)
	spec, _ := codeflowSpecHash(root, cacheDir)

	stubCodeflowInspect(t, mustJSON(codeflowInspectDoc(cacheDir, spec, "9000")), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "9000") || !strings.Contains(stderr, "9100") {
		t.Errorf("port drift warning must name live (9000) and expected (9100) ports, got: %q", stderr)
	}
	if !strings.Contains(stderr, "host port") {
		t.Errorf("warning must name the mapped port, got: %q", stderr)
	}
	assertCodeflowRecoveryCommands(t, stderr)
}

func TestWarnIfCodeflowDrift_settingsPortBeatsEnv(t *testing.T) {
	// Settings 9100 + env 9000: the check must follow settings, so a live
	// bind of the settings port with a matching stamp stays silent.
	_, root := mkWorkspace(t, `{"docker": {"codeflowPort": "9100"}}`)
	setUpReady(t)
	t.Setenv("CODEFLOW_PORT", "9000")
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)
	spec, _ := codeflowSpecHash(root, cacheDir)

	stubCodeflowInspect(t, mustJSON(codeflowInspectDoc(cacheDir, spec, "9100")), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if stderr != "" {
		t.Errorf("settings port must beat env in the drift check, got: %q", stderr)
	}
}

func TestWarnIfCodeflowDrift_derivedPortIgnored(t *testing.T) {
	// No settings/env port: the live published port is runtime allocation —
	// a different bind must NOT warn (probe occupancy shifts with no config
	// change).
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)
	spec, _ := codeflowSpecHash(root, cacheDir)

	stubCodeflowInspect(t, mustJSON(codeflowInspectDoc(cacheDir, spec, "9999")), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if stderr != "" {
		t.Errorf("derived-port allocation shift must not warn, got: %q", stderr)
	}
}

func TestWarnIfCodeflowDrift_hashMismatchWarns(t *testing.T) {
	// Same cache dir + same mount + derived port: only the composite stamp
	// can catch a same-path config.json content edit.
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	stubCodeflowInspect(t, mustJSON(codeflowInspectDoc(cacheDir, strings.Repeat("f", 64), "")), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "stamp") {
		t.Errorf("stamp mismatch must warn naming the stamp, got: %q", stderr)
	}
	assertCodeflowRecoveryCommands(t, stderr)
}
