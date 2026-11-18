package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// The migrate adapter edges: fail-closed input, the host-side promise, the
// registered surface plus the operator journey end to end.

// TestMigrate_MalformedSettingsError surfaces a broken file instead of
// swallowing it, and rewrites nothing.
func TestMigrate_MalformedSettingsError(t *testing.T) {
	root := staleWorkspace(t)
	testutil.WriteSettingsFile(t, root, `{"packages": `)
	cheaseeBefore := readBytes(t, cheaseeSettingsFile(root))

	_, err := runMigrate(t, root, "--confirm")
	if err == nil {
		t.Fatal("malformed .pi/settings.json must surface as an error")
	}
	assertBytesUnchanged(t, cheaseeSettingsFile(root), cheaseeBefore)
}

// TestMigrate_NoDockerRequired is the whole point of doing this on the host: the
// migration runs without a docker daemon and without pi.
func TestMigrate_NoDockerRequired(t *testing.T) {
	root := staleWorkspace(t)
	stubLookPath(t, func(string) (string, error) { return "", errors.New("docker: not found") })
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		t.Errorf("migrate must not shell out, got %s %v", name, arg)
		return &mockCmd{}
	})

	if _, err := runMigrate(t, root, "--confirm"); err != nil {
		t.Fatalf("migrate must run host-side only: %v", err)
	}
	assertAbsent(t, filepath.Join(root, ponytailClonePath))
}

// TestMigrate_Registered pins the command surface the rest of the CLI contract
// depends on (root_test.go group table, docs/cli.md).
func TestMigrate_Registered(t *testing.T) {
	if migrateCmd.Name() != "migrate" {
		t.Errorf("command name = %q, want migrate", migrateCmd.Name())
	}
	if migrateCmd.RunE == nil {
		t.Error("migrate must carry a RunE")
	}
	if !migrateCmd.DisableAutoGenTag {
		t.Error("migrate must set DisableAutoGenTag")
	}
	if migrateCmd.GroupID != groupIDMaintenance {
		t.Errorf("migrate GroupID = %q, want %q", migrateCmd.GroupID, groupIDMaintenance)
	}
	for _, name := range []string{"confirm", "dry-run", "workdir"} {
		if migrateCmd.Flags().Lookup(name) == nil {
			t.Errorf("migrate must register --%s", name)
		}
	}
	found := slices.ContainsFunc(rootCmd.Commands(), func(c *cobra.Command) bool { return c.Name() == "migrate" })
	if !found {
		t.Error("rootCmd must expose migrate")
	}
}

// TestMigrate_OperatorJourney is the user-facing scenario end to end: the stale
// workspace is inspected, then fixed, then quiet.
func TestMigrate_OperatorJourney(t *testing.T) {
	root := staleWorkspace(t)

	// 1. Inspect: the plan is printed, nothing changes.
	piBefore := readBytes(t, piSettingsFile(root))
	plan, err := runMigrate(t, root, "--dry-run")
	if err != nil {
		t.Fatalf("journey dry run: %v", err)
	}
	if !strings.Contains(plan, retiredPackageSource) {
		t.Errorf("plan must name the package, got: %q", plan)
	}
	assertBytesUnchanged(t, piSettingsFile(root), piBefore)

	// 2. Fix: the registrations and the checkout go.
	applied, err := runMigrate(t, root, "--confirm")
	if err != nil {
		t.Fatalf("journey confirm: %v", err)
	}
	if !strings.Contains(applied, "Removed") {
		t.Errorf("confirmed run must report removals, got: %q", applied)
	}
	assertAbsent(t, filepath.Join(root, ponytailClonePath))

	// 3. Verify: a rerun is silent, and the state the entrypoint consumes
	// (`skillRepos`) carries no deprecated spec.
	quiet, err := runMigrate(t, root, "--confirm")
	if err != nil {
		t.Fatalf("journey rerun: %v", err)
	}
	if strings.Contains(quiet, "Removed") {
		t.Errorf("rerun must be silent, got: %q", quiet)
	}
	specs := testutil.ReadCheaseeSettingsRaw(t, root)["skillRepos"]
	for _, spec := range asStrings(specs) {
		if strings.Contains(spec, ponytailSource) {
			t.Errorf("skillRepos still carries %q", spec)
		}
	}

	// 4. Nothing outside the workspace was touched: the two unrelated clones
	// and their registrations are still there.
	assertPresent(t, filepath.Join(root, keptSiblingClone))
	assertPresent(t, filepath.Join(root, keptSkillClone))
	if _, err := os.Stat(piSettingsFile(root)); err != nil {
		t.Fatalf("stat .pi/settings.json: %v", err)
	}
}

// TestMigrate_NotInitializedRefused keeps migrate consistent with the start
// gate: it never edits a folder cheasee-pi does not own.
func TestMigrate_NotInitializedRefused(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "somefile.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := runMigrate(t, dir, "--confirm"); err == nil {
		t.Fatal("migrate must refuse a folder that is not a cheasee-pi workspace")
	}
	if _, err := os.Stat(piSettingsFile(dir)); !os.IsNotExist(err) {
		t.Errorf("refused run must not create .pi/settings.json, stat err = %v", err)
	}
}

// asStrings flattens a decoded JSON array of strings, tolerating a missing or
// differently-typed value (a nil result simply asserts nothing).
func asStrings(value any) []string {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s, isString := item.(string); isString {
			out = append(out, s)
		}
	}
	return out
}
