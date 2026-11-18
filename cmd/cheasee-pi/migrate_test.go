package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// The migrate adapter report paths: plan, consent, confirm, rerun. Every test
// drives the real cobra command through testutil.RunCobra over captured stderr,
// because the report is an operator surface — not a return value.
// ──────────────────────────────────────────────

// runMigrate drives migrate the way the CLI does: --workdir is the only input,
// stderr carries the report, and RunE's error comes back unwrapped. The root
// command is the execution entry (cobra delegates ExecuteC to the root anyway),
// with the subcommand named first — the repo's RunCobra convention.
//
// The flag store is reset per call: pflag writes straight into the package
// variables and keeps the last parsed value, so a second Execute in one process
// would otherwise inherit the previous run's --dry-run. Production runs one
// command per process; only tests repeat one.
func runMigrate(t *testing.T, workdir string, args ...string) (stderr string, err error) {
	t.Helper()
	savedWorkdir, savedConfirm, savedDryRun := migrateWorkdir, migrateConfirm, migrateDryRun
	migrateWorkdir, migrateConfirm, migrateDryRun = workdir, false, false
	t.Cleanup(func() {
		migrateWorkdir, migrateConfirm, migrateDryRun = savedWorkdir, savedConfirm, savedDryRun
	})
	stderr = testutil.CaptureStderr(t, func() {
		_, err = testutil.RunCobra(t, rootCmd, append([]string{"migrate"}, args...)...)
	})
	return stderr, err
}

// TestMigrate_DryRun reports the plan and touches nothing.
func TestMigrate_DryRun(t *testing.T) {
	root := staleWorkspace(t)
	piBefore := readBytes(t, piSettingsFile(root))
	cheaseeBefore := readBytes(t, cheaseeSettingsFile(root))

	stderr, err := runMigrate(t, root, "--dry-run")
	if err != nil {
		t.Fatalf("migrate --dry-run: %v", err)
	}
	if !strings.Contains(stderr, "Would remove") || !strings.Contains(stderr, retiredPackageSource) {
		t.Errorf("dry run must print the plan, got: %q", stderr)
	}
	assertBytesUnchanged(t, piSettingsFile(root), piBefore)
	assertBytesUnchanged(t, cheaseeSettingsFile(root), cheaseeBefore)
	assertPresent(t, filepath.Join(root, ponytailClonePath))
}

// TestMigrate_NeedsConfirmExitZero keeps a start-like run non-fatal while it
// warns about the entry it cannot classify.
func TestMigrate_NeedsConfirmExitZero(t *testing.T) {
	root := staleWorkspaceWith(t, stalePackageBare, `"`+keptSkillRepo+`"`)

	stderr, err := runMigrate(t, root)
	if err != nil {
		t.Fatalf("migrate must exit zero on a confirmable entry: %v", err)
	}
	if !strings.Contains(stderr, "cheasee-pi migrate --confirm") {
		t.Errorf("warning must name the confirm command, got: %q", stderr)
	}
	if !strings.Contains(string(readBytes(t, piSettingsFile(root))), ponytailSource) {
		t.Error("an unconfirmed entry must stay registered")
	}
	assertPresent(t, filepath.Join(root, ponytailClonePath))
}

// TestMigrate_ConfirmRemoves is the operator's one-shot fix.
func TestMigrate_ConfirmRemoves(t *testing.T) {
	root := staleWorkspace(t)

	stderr, err := runMigrate(t, root, "--confirm")
	if err != nil {
		t.Fatalf("migrate --confirm: %v", err)
	}
	assertAbsent(t, filepath.Join(root, ponytailClonePath))
	raw := string(readBytes(t, piSettingsFile(root)))
	if strings.Contains(raw, ponytailSource) {
		t.Errorf(".pi/settings.json still registers the package:\n%s", raw)
	}
	if strings.Contains(string(readBytes(t, cheaseeSettingsFile(root))), ponytailSource) {
		t.Error("cheasee-settings.json still seeds the skill repo")
	}
	for _, want := range []string{retiredPackageSource, retiredCloneRel} {
		if !strings.Contains(stderr, want) {
			t.Errorf("report must name %q, got: %q", want, stderr)
		}
	}
}

// TestMigrate_SecondRunNoop pins the rerun: exit zero, no report, no rewrite.
func TestMigrate_SecondRunNoop(t *testing.T) {
	root := staleWorkspace(t)
	if _, err := runMigrate(t, root, "--confirm"); err != nil {
		t.Fatalf("first migrate: %v", err)
	}
	piBefore := readBytes(t, piSettingsFile(root))
	cheaseeBefore := readBytes(t, cheaseeSettingsFile(root))

	stderr, err := runMigrate(t, root, "--confirm")
	if err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	if strings.Contains(stderr, "Removed") {
		t.Errorf("converged run must report no removal, got: %q", stderr)
	}
	assertBytesUnchanged(t, piSettingsFile(root), piBefore)
	assertBytesUnchanged(t, cheaseeSettingsFile(root), cheaseeBefore)
}
