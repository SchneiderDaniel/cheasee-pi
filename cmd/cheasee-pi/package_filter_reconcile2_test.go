package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/spf13/cobra"
)

func TestReconcileDefaultPackageFilters_Idempotent(t *testing.T) {
	dir := t.TempDir()
	writeRawSettings(t, dir, `{"packages": ["https://github.com/DietrichGebert/ponytail"]}`)
	if err := reconcileDefaultPackageFilters(dir); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	first := readSettingsBytes(t, dir)

	if err := reconcileDefaultPackageFilters(dir); err != nil {
		t.Fatalf("second reconcile: %v", err)
	}
	if got := readSettingsBytes(t, dir); !bytes.Equal(first, got) {
		t.Errorf("reconcile must be byte-stable:\n first =%s\n second=%s", first, got)
	}
}

func TestReconcileDefaultPackageFilters_MalformedIsErrorAndUnwrites(t *testing.T) {
	dir := t.TempDir()
	writeRawSettings(t, dir, `{"packages": [`)
	before := readSettingsBytes(t, dir)

	if err := reconcileDefaultPackageFilters(dir); err == nil {
		t.Fatal("malformed settings must be a hard error, never silently overwritten")
	}
	if got := readSettingsBytes(t, dir); !bytes.Equal(before, got) {
		t.Errorf("malformed settings must be left untouched, got %s", got)
	}
}

func TestReconcileDefaultPackageFilters_WriteFailureSurfaces(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("directory permissions do not bind as root")
	}
	dir := t.TempDir()
	writeRawSettings(t, dir, `{"packages": ["https://github.com/DietrichGebert/ponytail"]}`)
	piDir := filepath.Dir(settingsPath(dir))
	if err := os.Chmod(piDir, 0555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(piDir, 0755) })

	if err := reconcileDefaultPackageFilters(dir); err == nil {
		t.Fatal("write failure must surface, not be swallowed")
	}
}

// ──────────────────────────────────────────────
// Phase 3: runUpE wiring (use-case)
// ──────────────────────────────────────────────

func TestRunUpE_ReconcilesDefaultPackageFilterBeforeContainer(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	writeRawSettings(t, root, `{"packages": [
		"https://github.com/DietrichGebert/ponytail",
		"https://github.com/SchneiderDaniel/private-pi"
	]}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	c := stubUpFlow(t, root, false)

	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}

	entries := readPackages(t, root)
	if len(entries) != 2 {
		t.Fatalf("expected two packages, got %d: %s", len(entries), entries)
	}
	assertDefaultFilterObject(t, entries[0])
	if !isBarePackageString(entries[1], "https://github.com/SchneiderDaniel/private-pi") {
		t.Errorf("non-default entry must stay a bare string, got %s", entries[1])
	}
	if len(c.composeArgs) != 2 {
		t.Errorf("expected build + up after reconcile, got %v", c.composeArgs)
	}
	if exec.name == "" {
		t.Error("expected the container exec to be reached")
	}
}

func TestRunUpE_ReconcileFailureHaltsBeforeCompose(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	writeRawSettings(t, root, `{"packages": [`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	c := stubUpFlow(t, root, false)

	if err := runUpE(&cobra.Command{}, nil); err == nil {
		t.Fatal("malformed settings must fail the start, not pass through to the entrypoint")
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("reconcile must halt before any compose call, got %v", c.composeArgs)
	}
	if exec.name != "" {
		t.Error("reconcile must halt before the container exec")
	}
}

// TestRunUpE_ReconcilesFilterPiJustCreated covers the brand-new workspace: there
// is no .pi/settings.json to upgrade before the container starts, so the
// entrypoint's `pi install -l -a` creates it with a bare string (simulated on
// the compose stub). The post-container pass must upgrade it before pi execs.

func TestRunUpE_ReconcilesFilterPiJustCreated(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)

	inner := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		r := inner(ctx, name, arg...)
		if name == "docker" && slices.Contains(arg, "compose") && slices.Contains(arg, "up") {
			// The container entrypoint's `pi install -l -a` is what first
			// creates the project settings file — pi owns it, with a bare
			// string entry.
			if m, ok := r.(*mockCmd); ok {
				m.runFn = func() error {
					writeRawSettings(t, root, `{"packages": ["`+defaultSkillRepos[0]+`"]}`)
					return nil
				}
			}
		}
		return r
	})

	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}
	if exec.name == "" {
		t.Fatal("expected the container exec to be reached")
	}
	entries := readPackages(t, root)
	if len(entries) != 1 {
		t.Fatalf("expected one package, got %d: %s", len(entries), entries)
	}
	assertDefaultFilterObject(t, entries[0])
}
