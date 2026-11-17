package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// Retirement stage (#2137) start-flow tests: the persistent workspace must be
// reconciled before the container starts, because the entrypoint reinstalls
// every skillRepos spec on each start.

// TestRunUpE_retireDryRunTouchesNothing extends the dry-run contract to the
// retirement stage: a dry run reports the plan and rewrites nothing.
func TestRunUpE_retireDryRunTouchesNothing(t *testing.T) {
	root := staleWorkspaceWith(t, stalePackageObject, `"`+keptSkillRepo+`"`)
	setUpRun(t, root) // dry-run mode
	c := stubUpFlow(t, root, false)
	piBefore := readBytes(t, piSettingsFile(root))
	cheaseeBefore := readBytes(t, cheaseeSettingsFile(root))

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	if len(c.composeArgs) != 0 {
		t.Errorf("dry-run must not invoke compose, got %d: %v", len(c.composeArgs), c.composeArgs)
	}
	assertBytesUnchanged(t, piSettingsFile(root), piBefore)
	assertBytesUnchanged(t, cheaseeSettingsFile(root), cheaseeBefore)
	assertPresent(t, filepath.Join(root, ponytailClonePath))
	if strings.Contains(stderr, "Removed") || strings.Contains(stderr, "Would remove") {
		t.Errorf("dry-run must not print a retirement report, got: %q", stderr)
	}
}

// TestRunUpE_retireRunsBeforeContainerStart pins the ordering the bug depends
// on: by the time compose runs, the workspace no longer registers the package
// plus the checkout is gone.
func TestRunUpE_retireRunsBeforeContainerStart(t *testing.T) {
	root := staleWorkspaceWith(t, stalePackageObject, `"`+keptSkillRepo+`"`)
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)
	c := stubUpFlow(t, root, false)

	// Wrap the stubbed docker seam: the first compose call must already see a
	// migrated workspace.
	inner := runCommandContext
	var observed []string
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "compose") {
			if raw := string(readBytes(t, piSettingsFile(root))); strings.Contains(raw, ponytailSource) {
				observed = append(observed, ".pi/settings.json still registered the package at compose time")
			}
			if _, err := os.Lstat(filepath.Join(root, ponytailClonePath)); !os.IsNotExist(err) {
				observed = append(observed, "the checkout still existed at compose time")
			}
		}
		return inner(ctx, name, arg...)
	})

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	if len(c.composeArgs) == 0 {
		t.Fatal("the start must reach compose")
	}
	for _, problem := range observed {
		t.Errorf("retirement must run before ensureContainerReady: %s", problem)
	}
	if !strings.Contains(stderr, "Removed") || !strings.Contains(stderr, retiredPackageSource) {
		t.Errorf("start must print the retirement report, got: %q", stderr)
	}
}

// TestRunUpE_retireLiveSessionRefusedAbortsStart refuses to rewrite settings
// under a live session — the start fails instead of racing it.
func TestRunUpE_retireLiveSessionRefusedAbortsStart(t *testing.T) {
	root := staleWorkspaceWith(t, stalePackageObject, `"`+keptSkillRepo+`"`)
	claim := claimLiveSessionID(t, root, "livebeef")
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)
	c := stubUpFlow(t, root, false)
	piBefore := readBytes(t, piSettingsFile(root))

	err := runUpE(&cobra.Command{}, nil)
	if err == nil {
		t.Fatal("a live session must abort the start")
	}
	if !strings.Contains(err.Error(), "running session") {
		t.Errorf("error must name the running session, got %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("the refusal must abort before compose, got %d: %v", len(c.composeArgs), c.composeArgs)
	}
	assertBytesUnchanged(t, piSettingsFile(root), piBefore)
	assertPresent(t, filepath.Join(root, ponytailClonePath))
	assertPresent(t, claim)
}

// TestRunUpE_retireConvergedQuiet keeps a normal start silent: a clean
// workspace prints no retirement line, still reaching the container.
func TestRunUpE_retireConvergedQuiet(t *testing.T) {
	root := cleanWorkspace(t)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	c := stubUpFlow(t, root, false)
	piBefore := readBytes(t, piSettingsFile(root))
	cheaseeBefore := readBytes(t, cheaseeSettingsFile(root))

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	if strings.Contains(stderr, "Removed") || strings.Contains(stderr, "Would remove") {
		t.Errorf("a converged workspace must not print a retirement report, got: %q", stderr)
	}
	assertBytesUnchanged(t, piSettingsFile(root), piBefore)
	assertBytesUnchanged(t, cheaseeSettingsFile(root), cheaseeBefore)
	if len(c.composeArgs) == 0 {
		t.Error("the start must still reach compose")
	}
	if exec.name == "" {
		t.Error("the start must still exec pi")
	}
}

// TestRunUpE_retireContainerRecreationEquivalent simulates the reported bug's
// trigger: a container rebuild/recreate is a second `start` on the same
// persisted workspace. Nothing may come back; the `skillRepos` list the
// entrypoint reads must stay empty of the deprecated spec.
func TestRunUpE_retireContainerRecreationEquivalent(t *testing.T) {
	root := staleWorkspaceWith(t, stalePackageObject, `"`+keptSkillRepo+`"`)
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)
	stubUpFlow(t, root, false)

	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("first start: %v", err)
	}
	piAfterFirst := readBytes(t, piSettingsFile(root))
	cheaseeAfterFirst := readBytes(t, cheaseeSettingsFile(root))

	// Second start = the recreated container starting against the same mount.
	c := stubUpFlow(t, root, false)
	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("second start: %v", err)
		}
	})

	if strings.Contains(stderr, "Removed") {
		t.Errorf("the recreated container must not need a second migration, got: %q", stderr)
	}
	assertBytesUnchanged(t, piSettingsFile(root), piAfterFirst)
	assertBytesUnchanged(t, cheaseeSettingsFile(root), cheaseeAfterFirst)
	assertAbsent(t, filepath.Join(root, ponytailClonePath))
	if len(c.composeArgs) == 0 {
		t.Error("the recreated container must still start the stack")
	}
	for _, spec := range asStrings(testutil.ReadCheaseeSettingsRaw(t, root)["skillRepos"]) {
		if strings.Contains(spec, ponytailSource) {
			t.Errorf("skillRepos still feeds the entrypoint the deprecated spec %q", spec)
		}
	}
}
