package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// The consent plus safety guards: what waits for --confirm, what keeps the
// checkout alive, the live-session refusal, and the symlink refusal.

// TestRetirePackages_NeedsConfirmWithoutFlag is the issue's explicit-consent
// requirement: a bare-string registration with no harness provenance is left
// alone, the run warns with the exact follow-up command, and a start continues.
func TestRetirePackages_NeedsConfirmWithoutFlag(t *testing.T) {
	root := staleWorkspaceWith(t, stalePackageBare, `"`+keptSkillRepo+`"`)
	piBefore := readBytes(t, piSettingsFile(root))
	cheaseeBefore := readBytes(t, cheaseeSettingsFile(root))

	var rep retireReport
	stderr := testutil.CaptureStderr(t, func() {
		var err error
		rep, err = retirePackages(root, retireOptions{})
		if err != nil {
			t.Fatalf("retirePackages must not fail on a confirmable entry: %v", err)
		}
	})

	assertBytesUnchanged(t, piSettingsFile(root), piBefore)
	assertBytesUnchanged(t, cheaseeSettingsFile(root), cheaseeBefore)
	assertPresent(t, filepath.Join(root, ponytailClonePath))
	if !slices.Contains(rep.NeedsConfirmation, retiredPackageSource) {
		t.Errorf("report must name the entry it left for confirmation, got %+v", rep)
	}
	if !strings.Contains(stderr, "cheasee-pi migrate --confirm") {
		t.Errorf("warning must name the confirm command, got: %q", stderr)
	}
}

// TestRetirePackages_NeedsConfirmWithFlag is the same workspace with consent:
// now the entry and its checkout go.
func TestRetirePackages_NeedsConfirmWithFlag(t *testing.T) {
	root := staleWorkspaceWith(t, stalePackageBare, `"`+keptSkillRepo+`"`)

	rep, err := retirePackages(root, retireOptions{Confirm: true})
	if err != nil {
		t.Fatalf("retirePackages: %v", err)
	}

	if strings.Contains(string(readBytes(t, piSettingsFile(root))), ponytailSource) {
		t.Error("confirmed run must remove the bare-string registration")
	}
	assertAbsent(t, filepath.Join(root, ponytailClonePath))
	if !slices.Contains(rep.Removed, retiredPackageSource) {
		t.Errorf("report must name the removal, got %+v", rep)
	}
}

// TestRetirePackages_CloneKeptWhileVariantRemains refuses to delete a checkout
// something still resolves to: a variant spelling is not the removed entry, so
// it keeps the clone alive.
func TestRetirePackages_CloneKeptWhileVariantRemains(t *testing.T) {
	t.Run("packages .git variant", func(t *testing.T) {
		root := staleWorkspaceWith(t,
			stalePackageObject+`, {"source": "`+ponytailSource+`.git"}`,
			`"`+keptSkillRepo+`"`)
		if _, err := retirePackages(root, retireOptions{}); err != nil {
			t.Fatalf("retirePackages: %v", err)
		}
		assertPresent(t, filepath.Join(root, ponytailClonePath))
	})
	t.Run("skillRepos ref variant", func(t *testing.T) {
		root := staleWorkspaceWith(t,
			stalePackageObject,
			`"`+retiredPackageSource+`@v1"`)
		if _, err := retirePackages(root, retireOptions{}); err != nil {
			t.Fatalf("retirePackages: %v", err)
		}
		assertPresent(t, filepath.Join(root, ponytailClonePath))
	})
}

// TestRetirePackages_LiveSessionRefused refuses while a session holds the
// workspace: rewriting settings under a running pi is exactly the race the
// claim file exists to expose.
func TestRetirePackages_LiveSessionRefused(t *testing.T) {
	root := staleWorkspace(t)
	claim := claimLiveSessionID(t, root, "deadbeef")
	piBefore := readBytes(t, piSettingsFile(root))
	cheaseeBefore := readBytes(t, cheaseeSettingsFile(root))

	_, err := retirePackages(root, retireOptions{})
	if err == nil {
		t.Fatal("a live session claim must refuse the migration")
	}
	if !strings.Contains(err.Error(), "running session") {
		t.Errorf("error must tell the user to close the running session, got %v", err)
	}
	// A claim can outlive a killed session, and "close it" is not actionable
	// when there is nothing to close: the recovery must be named too.
	if !strings.Contains(err.Error(), "cheasee-pi down") {
		t.Errorf("error must name the stale-claim recovery, got %v", err)
	}

	assertBytesUnchanged(t, piSettingsFile(root), piBefore)
	assertBytesUnchanged(t, cheaseeSettingsFile(root), cheaseeBefore)
	assertPresent(t, filepath.Join(root, ponytailClonePath))
	assertPresent(t, claim)
}

// TestRetirePackages_LiveSessionClearedThenSucceeds proves the guard is a state
// check, not a sticky lock: once the claim is gone the migration runs.
func TestRetirePackages_LiveSessionClearedThenSucceeds(t *testing.T) {
	root := staleWorkspace(t)
	claim := claimLiveSessionID(t, root, "deadbeef")
	if _, err := retirePackages(root, retireOptions{}); err == nil {
		t.Fatal("expected the live-session refusal")
	}
	if err := os.Remove(claim); err != nil {
		t.Fatalf("remove claim: %v", err)
	}

	if _, err := retirePackages(root, retireOptions{}); err != nil {
		t.Fatalf("retirePackages after the claim cleared: %v", err)
	}
	assertAbsent(t, filepath.Join(root, ponytailClonePath))
}
