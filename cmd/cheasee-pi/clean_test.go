package main

import (
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// cleanTestStub stubs the docker commands runCleanE issues: docker ps (name
// lookup), docker exec scans (report lines) and inert prune commands.
// Returns a pointer to the number of docker exec scan invocations.
func cleanTestStub(t *testing.T, containerName, scanOutput string) *int {
	t.Helper()
	execCalls := 0
	stubExecCommand(t, func(name string, arg ...string) cmdIface {
		if name != "docker" {
			return &mockCmd{}
		}
		if slices.Contains(arg, "ps") {
			name := containerName
			for i, a := range arg {
				if strings.HasPrefix(a, "name=") && i > 0 && arg[i-1] == "--filter" {
					name = strings.TrimPrefix(a, "name=")
				}
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(name), nil }}
		}
		if slices.Contains(arg, "images") || slices.Contains(arg, "buildx") {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, nil }}
		}
		execCalls++
		return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(scanOutput), nil }}
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

func TestRunCleanE_dryRunReportsWithoutKilling(t *testing.T) {
	resetCleanState(t)
	cleanDryRun = true

	calls := cleanTestStub(t, "cheasee-pi", "killing 42 (age 60m)\nkilling 99 (age 45m)\n")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(&cobra.Command{}, nil); err != nil {
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
		if err := runCleanE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if *calls != 1 {
		t.Errorf("aborted clean must only preview (one scan), got %d", *calls)
	}
	if !strings.Contains(stderr, "Aborted") {
		t.Errorf("abort must be reported, got %q", stderr)
	}
}

func TestRunCleanE_confirmYesKills(t *testing.T) {
	resetCleanState(t)
	saved := cleanConfirmFn
	cleanConfirmFn = func(string) (bool, error) { return true, nil }
	t.Cleanup(func() { cleanConfirmFn = saved })

	calls := cleanTestStub(t, "cheasee-pi", "killing 42 (age 60m)\n")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if *calls != 2 {
		t.Errorf("confirmed clean must preview then kill (two scans), got %d", *calls)
	}
	if !strings.Contains(stderr, "Killed 1 pi session(s)") {
		t.Errorf("kill must be reported, got %q", stderr)
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
		if err := runCleanE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if *calls != 1 {
		t.Errorf("--yes must run a single real scan, got %d", *calls)
	}
	if !strings.Contains(stderr, "Killed 1 pi session(s)") {
		t.Errorf("kill must be reported, got %q", stderr)
	}
}

func TestRunCleanE_noCandidatesStillPrunes(t *testing.T) {
	resetCleanState(t)
	cleanYes = true

	calls := cleanTestStub(t, "cheasee-pi", "")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if *calls != 1 {
		t.Errorf("expected one scan, got %d", *calls)
	}
	if !strings.Contains(stderr, "No stale pi sessions found") {
		t.Errorf("expected no-stale message, got %q", stderr)
	}
}
