package main

import (
	"context"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// cleanTestStub stubs the docker commands runCleanE issues: docker ps
// (returns containerName for every filter — a host with exactly this one
// managed container), docker exec scans (report lines) and inert
// rm/prune/image calls. Returns a pointer to the number of docker exec scan
// invocations.
func cleanTestStub(t *testing.T, containerName, scanOutput string) *int {
	t.Helper()
	execCalls := 0
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		if len(arg) > 0 && arg[0] == "exec" {
			execCalls++
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(scanOutput), nil }}
		}
		if len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(containerName), nil }}
		}
		return &mockCmd{} // rm -f, image prune, buildx prune
	})
	return &execCalls
}

// resetCleanState pins the clean package vars for the duration of a test.

func resetCleanState(t *testing.T) {
	t.Helper()
	cleanName = "cheasee-pi"
	cleanMaxAge = 30
	cleanDryRun = false
	cleanYes = false
	t.Cleanup(func() {
		cleanName = ""
		cleanMaxAge = 0
		cleanDryRun = false
		cleanYes = false
	})
}

// newCleanCmd returns a clean command with the real flag defaults, so
// flags.Changed("name") is false unless the test sets the flag.

func newCleanCmd() *cobra.Command {
	cmd := &cobra.Command{}
	cmd.Flags().StringVar(&cleanName, "name", "cheasee-pi", "Container name")
	return cmd
}

func TestRunCleanE_dryRunReportsWithoutKilling(t *testing.T) {
	resetCleanState(t)
	cleanDryRun = true

	calls := cleanTestStub(t, "cheasee-pi", "killing 42 (age 60m)\nkilling 99 (age 45m)\n")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if *calls != 1 {
		t.Errorf("dry-run must run exactly one scan, got %d", *calls)
	}
	if !strings.Contains(stderr, "killing 42") || !strings.Contains(stderr, "killing 99") {
		t.Errorf("dry-run must report candidates, got %q", stderr)
	}
	if !strings.Contains(stderr, "Dry-run") {
		t.Errorf("dry-run must be labeled, got %q", stderr)
	}
}

func TestRunCleanE_confirmAbortKillsNothing(t *testing.T) {
	resetCleanState(t)
	saved := cleanConfirmFn
	cleanConfirmFn = func(string) (bool, error) { return false, nil }
	t.Cleanup(func() { cleanConfirmFn = saved })

	calls := cleanTestStub(t, "cheasee-pi", "killing 42 (age 60m)\n")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if *calls != 1 {
		t.Errorf("aborted clean must only preview (one scan), got %d", *calls)
	}
	if !strings.Contains(stderr, "Aborted") {
		t.Errorf("abort must be reported, got %q", stderr)
	}
	if strings.Contains(stderr, "Removed container") {
		t.Errorf("aborted clean must not remove containers, got %q", stderr)
	}
}

func TestRunCleanE_confirmYesKillsAndRemoves(t *testing.T) {
	resetCleanState(t)
	saved := cleanConfirmFn
	cleanConfirmFn = func(string) (bool, error) { return true, nil }
	t.Cleanup(func() { cleanConfirmFn = saved })

	calls := cleanTestStub(t, "cheasee-pi", "killing 42 (age 60m)\n")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if *calls != 2 {
		t.Errorf("confirmed clean must preview then kill (two scans), got %d", *calls)
	}
	if !strings.Contains(stderr, "Killed 1 pi session(s)") {
		t.Errorf("kill must be reported, got %q", stderr)
	}
	if !strings.Contains(stderr, "Removed container cheasee-pi") {
		t.Errorf("confirmed clean must remove the container, got %q", stderr)
	}
}

func TestRunCleanE_yesFlagSkipsConfirm(t *testing.T) {
	resetCleanState(t)
	cleanYes = true
	cleanConfirmFn = func(string) (bool, error) {
		t.Error("confirm must be skipped with --yes")
		return false, nil
	}

	calls := cleanTestStub(t, "cheasee-pi", "killing 42 (age 60m)\n")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if *calls != 1 {
		t.Errorf("--yes must run a single real scan, got %d", *calls)
	}
	if !strings.Contains(stderr, "Killed 1 pi session(s)") {
		t.Errorf("kill must be reported, got %q", stderr)
	}
	if !strings.Contains(stderr, "Removed container cheasee-pi") {
		t.Errorf("--yes clean must remove the container, got %q", stderr)
	}
}
