package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestCodeflowSpecHash_explicitPortPrecedence(t *testing.T) {
	cacheDir := t.TempDir()
	writeCodeflowCacheDir(t, cacheDir)

	// Settings docker.codeflowPort beats env CODEFLOW_PORT.
	_, root := mkWorkspace(t, `{"docker": {"codeflowPort": "9100"}}`)
	setUpReady(t)
	t.Setenv("CODEFLOW_PORT", "9000")
	withSettings, err := codeflowSpecHash(root, cacheDir)
	if err != nil {
		t.Fatal(err)
	}

	envRoot := filepath.Join(t.TempDir(), "ws")
	if err := os.MkdirAll(envRoot, 0755); err != nil {
		t.Fatal(err)
	}
	testutil.WriteCheaseeSettingsFile(t, envRoot, `{}`)
	t.Setenv("CODEFLOW_PORT", "9000")
	envHash, err := codeflowSpecHash(envRoot, cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	if envHash == withSettings {
		t.Error("settings codeflowPort must beat env in the hash")
	}

	// Both absent → derived sentinel; the port is excluded, so two roots
	// with DIFFERENT derived ports must hash identically (runtime
	// allocation must not read as drift).
	t.Setenv("CODEFLOW_PORT", "")
	rootA := filepath.Join(t.TempDir(), "ws-a")
	rootB := filepath.Join(t.TempDir(), "ws-b")
	if err := os.MkdirAll(rootA, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(rootB, 0755); err != nil {
		t.Fatal(err)
	}
	testutil.WriteCheaseeSettingsFile(t, rootA, `{}`)
	testutil.WriteCheaseeSettingsFile(t, rootB, `{}`)
	ha, err := codeflowSpecHash(rootA, cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	hb, err := codeflowSpecHash(rootB, cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	if ha != hb {
		t.Errorf("derived port must be excluded from the hash (sentinel): %s vs %s", ha, hb)
	}
	if ha == envHash {
		t.Error("derived sentinel must differ from an explicit env port")
	}
}

func TestCodeflowSpecHash_missingFilesNoStamp(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)

	// Neither file extracted → no stamp, no error (pre-extraction fixture).
	spec, err := codeflowSpecHash(root, t.TempDir())
	if err != nil {
		t.Fatalf("missing files must not error, got %v", err)
	}
	if spec != "" {
		t.Errorf("missing files must yield no stamp, got %q", spec)
	}

	// Only config.json missing (compose file present) → same.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	spec, err = codeflowSpecHash(root, dir)
	if err != nil || spec != "" {
		t.Errorf("missing config.json with compose present must give no stamp / no error, got (%q, %v)", spec, err)
	}
}

func TestCodeflowSpecHash_readErrorSurfaces(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)
	dir := t.TempDir()
	// ENOTDIR: config.json's parent is a regular file — not IsNotExist, so
	// the error must surface (a silent no-stamp would hide the failure).
	if err := os.WriteFile(filepath.Join(dir, "codeflow"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := codeflowSpecHash(root, dir); err == nil {
		t.Fatal("non-NotExist read error must surface")
	}
}

// ──────────────────────────────────────────────
// Phase 2: inspectCodeflowSpec parsing
// ──────────────────────────────────────────────

func TestInspectCodeflowSpec_parsesLiveJSON(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ws")
	cacheDir := t.TempDir()
	doc := codeflowInspectDoc(cacheDir, "abc123", "9000")

	var gotArgs []string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" {
			gotArgs = append([]string(nil), arg...)
			return codeflowInspectRunner(mustJSON(doc))
		}
		return &mockCmd{}
	})

	spec, err := inspectCodeflowSpec(context.Background(), root)
	if err != nil {
		t.Fatalf("inspectCodeflowSpec: %v", err)
	}
	if !slices.Contains(gotArgs, codeflowContainerName(root)) {
		t.Errorf("inspect must target the derived sidecar container %s, got %v", codeflowContainerName(root), gotArgs)
	}
	if spec.Missing {
		t.Error("existing container must not read as missing")
	}
	if spec.Config.Labels[codeflowSpecLabel] != "abc123" {
		t.Errorf("label parse: got %q, want abc123", spec.Config.Labels[codeflowSpecLabel])
	}
	if got, _ := codeflowConfigMountSource(spec); got != filepath.Join(cacheDir, "codeflow", "config.json") {
		t.Errorf("mount source parse: got %q", got)
	}
	if got := codeflowBoundHostPort(spec); got != "9000" {
		t.Errorf("bound host port parse: got %q, want 9000", got)
	}
	if !spec.State.Running {
		t.Error("State.Running must parse as true")
	}
}
