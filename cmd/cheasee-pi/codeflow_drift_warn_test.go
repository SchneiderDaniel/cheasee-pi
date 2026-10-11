package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestWarnIfCodeflowDrift_noLabelOldContainerSilent(t *testing.T) {
	// Pre-upgrade sidecar without the spec label: no hash warning, and with
	// all fields matching (mount + derived port) nothing prints.
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	stubCodeflowInspect(t, mustJSON(codeflowInspectDoc(cacheDir, "", "")), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if stderr != "" {
		t.Errorf("label-less sidecar with matching fields must be silent, got: %q", stderr)
	}
}

func TestWarnIfCodeflowDrift_missingSidecarWarns(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	stubCodeflowInspect(t, "Error: No such object: codeflow-ws", exitStatusError(1))
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "does not exist") {
		t.Errorf("missing sidecar must warn naming the missing state, got: %q", stderr)
	}
	assertCodeflowRecoveryCommands(t, stderr)
}

func TestWarnIfCodeflowDrift_stoppedSidecarWarns(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	doc := codeflowInspectDoc(cacheDir, "", "")
	doc["State"] = map[string]any{"Running": false, "StartedAt": "2024-01-01T00:00:00Z"}
	stubCodeflowInspect(t, mustJSON(doc), nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "stopped") {
		t.Errorf("stopped sidecar must warn naming the stopped state, got: %q", stderr)
	}
	assertCodeflowRecoveryCommands(t, stderr)
}

func TestWarnIfCodeflowDrift_inspectFailureWarnsNonFatal(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	stubCodeflowInspect(t, "", fmt.Errorf("daemon gone"))
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "could not verify") {
		t.Errorf("inspect failure must warn 'could not verify', got: %q", stderr)
	}
	assertCodeflowRecoveryCommands(t, stderr)
}

func TestWarnIfCodeflowDrift_badJSONWarnsNonFatal(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	stubCodeflowInspect(t, "{not json", nil)
	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "could not verify") {
		t.Errorf("bad inspect JSON must warn 'could not verify', got: %q", stderr)
	}
}

func TestWarnIfCodeflowDrift_hashErrorWarnsNonFatal(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	cacheDir := t.TempDir()
	// `codeflow` is a regular file → reading codeflow/config.json hits
	// ENOTDIR: the check cannot compute the expected state.
	if err := os.WriteFile(filepath.Join(cacheDir, "codeflow"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	stderr := testutil.CaptureStderr(t, func() {
		warnIfCodeflowDrift(context.Background(), root, cacheDir)
	})
	if !strings.Contains(stderr, "could not compute") {
		t.Errorf("hash failure must warn 'could not compute the expected configuration', got: %q", stderr)
	}
	assertCodeflowRecoveryCommands(t, stderr)
}

// ──────────────────────────────────────────────
// Phase 5: stamp env injection (stamp-vs-compare consistency)
// ──────────────────────────────────────────────

func TestApplyComposeEnv_injectsCodeflowSpecStamp(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	composeDir := t.TempDir()
	writeCodeflowCacheDir(t, composeDir)
	spec, err := codeflowSpecHash(root, composeDir)
	if err != nil {
		t.Fatal(err)
	}

	cmd := &mockCmd{}
	applyComposeEnv(cmd, root, containerName(root), composeDir)

	var hits []string
	for _, e := range cmd.env {
		if k, v, ok := strings.Cut(e, "="); ok && k == codeflowSpecEnv {
			hits = append(hits, v)
		}
	}
	if len(hits) != 1 || hits[0] != spec {
		t.Errorf("exactly one %s=<hash> entry expected (stamp-vs-compare consistency), got %v (want %s)", codeflowSpecEnv, hits, spec)
	}
}

func TestApplyComposeEnv_inheritedSpecStampReplaced(t *testing.T) {
	// An inherited CHEASEEPI_CODEFLOW_SPEC must be stripped and replaced —
	// a stale inherited stamp would otherwise mislabel a fresh container.
	t.Setenv("CHEASEEPI_CODEFLOW_SPEC", "11223344556677889900aabbccddeeff")
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	composeDir := t.TempDir()
	writeCodeflowCacheDir(t, composeDir)
	spec, err := codeflowSpecHash(root, composeDir)
	if err != nil {
		t.Fatal(err)
	}

	cmd := &mockCmd{}
	applyComposeEnv(cmd, root, containerName(root), composeDir)

	var hits []string
	for _, e := range cmd.env {
		if k, v, ok := strings.Cut(e, "="); ok && k == codeflowSpecEnv {
			hits = append(hits, v)
		}
	}
	if len(hits) != 1 || hits[0] != spec {
		t.Errorf("inherited stamp must be replaced by exactly one fresh entry, got %v (want %s)", hits, spec)
	}
}
