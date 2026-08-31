package main

import (
	"context"
	"fmt"
	"slices"
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

func TestRunCleanE_noCandidatesStillPrunes(t *testing.T) {
	resetCleanState(t)
	cleanYes = true

	calls := cleanTestStub(t, "cheasee-pi", "")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if *calls != 1 {
		t.Errorf("expected one scan, got %d", *calls)
	}
	if !strings.Contains(stderr, "No stale pi sessions found") {
		t.Errorf("expected no-stale message, got %q", stderr)
	}
	// Containers are still removed even with zero stale sessions.
	if !strings.Contains(stderr, "Removed container cheasee-pi") {
		t.Errorf("clean must remove containers even with no stale sessions, got %q", stderr)
	}
}

// cleanMultiStub simulates a host with several managed containers: the label
// pass lists all of them, the legacy name passes list the same set, and each
// docker exec scan returns the given report lines.
func cleanMultiStub(t *testing.T, containers []string, scanOutput string) {
	t.Helper()
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		if len(arg) > 0 && arg[0] == "exec" {
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(scanOutput), nil }}
		}
		if len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(strings.Join(containers, "\n")), nil }}
		}
		return &mockCmd{}
	})
}

func TestRunCleanE_defaultCoversAllRepos(t *testing.T) {
	resetCleanState(t)
	cleanYes = true
	cleanMaxAge = 0

	// Two repos' containers (derived names) + a legacy pre-derivation one.
	cleanMultiStub(t, []string{"cheasee-pi-repoA", "cheasee-pi-repoB", "cheasee-pi"}, "killing 42\n")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	// Every enumerated container is removed (3 × docker rm -f).
	for _, want := range []string{"cheasee-pi-repoA", "cheasee-pi-repoB", "cheasee-pi"} {
		if !strings.Contains(stderr, "Removed container "+want) {
			t.Errorf("clean must remove %s, got %q", want, stderr)
		}
	}
	// 3 containers × 1 orphan scan each → aggregated kill report.
	if !strings.Contains(stderr, "Killed 3 pi session(s)") {
		t.Errorf("aggregated kill report expected, got %q", stderr)
	}
}

func TestRunCleanE_nameFlagScopesSingleContainer(t *testing.T) {
	resetCleanState(t)
	cleanYes = true
	cleanMaxAge = 0

	// Host has several containers, but --name scopes to one.
	cleanMultiStub(t, []string{"cheasee-pi-repoA", "cheasee-pi-repoB"}, "killing 42\n")
	cmd := newCleanCmd()
	if err := cmd.Flags().Set("name", "cheasee-pi-repoA"); err != nil {
		t.Fatal(err)
	}
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(cmd, nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if !strings.Contains(stderr, "Removed container cheasee-pi-repoA") {
		t.Errorf("--name scope must remove the named container, got %q", stderr)
	}
	if strings.Contains(stderr, "Removed container cheasee-pi-repoB") {
		t.Errorf("--name scope must not touch other containers, got %q", stderr)
	}
}

func TestRunCleanE_rmFailureSurfaces(t *testing.T) {
	resetCleanState(t)
	cleanYes = true
	cleanMaxAge = 0

	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		if len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("cheasee-pi-a\ncheasee-pi-b\n"), nil }}
		}
		if len(arg) > 0 && arg[0] == "exec" {
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		if len(arg) > 0 && arg[0] == "rm" && slices.Contains(arg, "cheasee-pi-b") {
			return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("container gone") }}
		}
		return &mockCmd{}
	})

	err := runCleanE(newCleanCmd(), nil)
	if err == nil || !strings.Contains(err.Error(), "cheasee-pi-b") {
		t.Fatalf("rm failure must surface naming the container, got %v", err)
	}
}

func TestRunCleanE_emptyEnumerationNoop(t *testing.T) {
	resetCleanState(t)
	cleanYes = true
	cleanMaxAge = 0

	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		return &mockCmd{}
	})
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if strings.Contains(stderr, "Removed container") {
		t.Errorf("empty enumeration must remove nothing, got %q", stderr)
	}
	if !strings.Contains(stderr, "No stale pi sessions found") {
		t.Errorf("expected no-stale message, got %q", stderr)
	}
}

func TestRunCleanE_enumerationFailureSurfaces(t *testing.T) {
	resetCleanState(t)
	cleanYes = true

	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
		}
		return &mockCmd{}
	})
	err := runCleanE(newCleanCmd(), nil)
	if err == nil || !strings.Contains(err.Error(), "enumerate") {
		t.Fatalf("enumeration failure must surface, got %v", err)
	}
}

func TestRunCleanE_pruneConfirmations(t *testing.T) {
	resetCleanState(t)
	cleanYes = true
	cleanMaxAge = 0

	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		if len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("cheasee-pi\n"), nil }}
		}
		if len(arg) > 0 && arg[0] == "exec" {
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		if slices.Contains(arg, "images") {
			// A dangling image exists → the prune actually runs.
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("sha256:abc\n"), nil }}
		}
		return &mockCmd{combinedFn: func() ([]byte, error) { return nil, nil }}
	})
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if !strings.Contains(stderr, "Pruned dangling Docker images") {
		t.Errorf("dangling-image prune confirmation missing, got %q", stderr)
	}
	if !strings.Contains(stderr, "Pruned Docker build cache") {
		t.Errorf("build-cache prune confirmation missing, got %q", stderr)
	}
}
