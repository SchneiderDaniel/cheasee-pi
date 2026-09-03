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

func TestRunCleanE_dryRunYesComboStaysReportOnly(t *testing.T) {
	// --dry-run --yes must behave exactly like --dry-run alone: dry-run
	// precedence wins, one preview scan, nothing killed/removed/pruned.
	resetCleanState(t)
	cleanDryRun = true

	dryCalls := cleanTestStub(t, "cheasee-pi", "killing 42 (age 60m)\n")
	dryStderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})
	if *dryCalls != 1 {
		t.Errorf("dry-run must run exactly one scan, got %d", *dryCalls)
	}

	resetCleanState(t)
	cleanDryRun = true
	cleanYes = true
	comboCalls := cleanTestStub(t, "cheasee-pi", "killing 42 (age 60m)\n")
	comboStderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if *comboCalls != 1 {
		t.Errorf("--dry-run --yes must run exactly one preview scan, got %d", *comboCalls)
	}
	if comboStderr != dryStderr {
		t.Errorf("--dry-run --yes output must match dry-run alone:\ncombo:   %q\ndry-run: %q", comboStderr, dryStderr)
	}
	for _, forbidden := range []string{"Killed", "Removed container", "Pruned"} {
		if strings.Contains(comboStderr, forbidden) {
			t.Errorf("--dry-run --yes must not %q, got %q", forbidden, comboStderr)
		}
	}
}

func TestRunCleanE_dryRunEmptyEnumeration(t *testing.T) {
	resetCleanState(t)
	cleanDryRun = true

	// docker ps lists nothing → zero targets → zero exec scans.
	calls := cleanTestStub(t, "", "killing 42\n")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if *calls != 0 {
		t.Errorf("zero targets must not scan, got %d exec calls", *calls)
	}
	if !strings.Contains(stderr, "No stale pi sessions found") {
		t.Errorf("expected no-stale message, got %q", stderr)
	}
	if strings.Contains(stderr, "Would remove") {
		t.Errorf("zero targets must not list removals, got %q", stderr)
	}
	if strings.Contains(stderr, "Pruned") {
		t.Errorf("dry-run must never prune, got %q", stderr)
	}
}

func TestRunCleanE_dryRunPreviewScanErrorSurfaces(t *testing.T) {
	resetCleanState(t)
	cleanDryRun = true

	// --name skips enumeration, so the first docker ps is the preview scan's
	// containerRunning check; its failure must surface as a wrapped clean error.
	cmd := newCleanCmd()
	if err := cmd.Flags().Set("name", "cheasee-pi"); err != nil {
		t.Fatal(err)
	}
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
		}
		return &mockCmd{}
	})
	err := runCleanE(cmd, nil)
	if err == nil || !strings.Contains(err.Error(), "clean: ") || !strings.Contains(err.Error(), "docker ps") {
		t.Fatalf("dry-run preview scan error must surface wrapped, got %v", err)
	}
}

func TestRunCleanE_confirmPreviewScanErrorSurfaces(t *testing.T) {
	// Same failing containerRunning check, confirm mode: the hoisted preview
	// scan must surface the identical wrapped error in its second consumer.
	resetCleanState(t)

	cmd := newCleanCmd()
	if err := cmd.Flags().Set("name", "cheasee-pi"); err != nil {
		t.Fatal(err)
	}
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
		}
		return &mockCmd{}
	})
	err := runCleanE(cmd, nil)
	if err == nil || !strings.Contains(err.Error(), "clean: ") || !strings.Contains(err.Error(), "docker ps") {
		t.Fatalf("confirm preview scan error must surface wrapped, got %v", err)
	}
}

func TestRunCleanE_confirmAbortStillPrunes(t *testing.T) {
	// Issue-mandated fall-through: abort skips kill/remove but still prunes
	// dangling images + build cache at the function tail.
	resetCleanState(t)
	saved := cleanConfirmFn
	cleanConfirmFn = func(string) (bool, error) { return false, nil }
	t.Cleanup(func() { cleanConfirmFn = saved })

	execCalls := 0
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		if len(arg) > 0 && arg[0] == "exec" {
			execCalls++
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte("killing 42 (age 60m)\n"), nil }}
		}
		if len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("cheasee-pi\n"), nil }}
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

	if execCalls != 1 {
		t.Errorf("aborted clean must only preview (one scan), got %d", execCalls)
	}
	if !strings.Contains(stderr, "Aborted") {
		t.Errorf("abort must be reported, got %q", stderr)
	}
	if strings.Contains(stderr, "Killed") || strings.Contains(stderr, "Removed container") {
		t.Errorf("abort must not kill or remove, got %q", stderr)
	}
	if !strings.Contains(stderr, "Pruned dangling Docker images") {
		t.Errorf("abort must still prune dangling images, got %q", stderr)
	}
	if !strings.Contains(stderr, "Pruned Docker build cache") {
		t.Errorf("abort must still prune build cache, got %q", stderr)
	}
}

func TestRunCleanE_confirmPromptUsesHoistedCandidates(t *testing.T) {
	// The confirm prompt must consume the hoisted preview candidates instead
	// of re-scanning: exact prompt + two scans total (preview + real kill).
	resetCleanState(t)
	prompt := "not-called"
	saved := cleanConfirmFn
	cleanConfirmFn = func(p string) (bool, error) { prompt = p; return true, nil }
	t.Cleanup(func() { cleanConfirmFn = saved })

	calls := cleanTestStub(t, "cheasee-pi", "killing 42 (age 60m)\n")
	testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if *calls != 2 {
		t.Errorf("confirmed clean must preview then kill (two scans), got %d", *calls)
	}
	if want := "Kill 1 pi session(s) and remove 1 container(s)?"; prompt != want {
		t.Errorf("prompt must reuse hoisted candidates, got %q, want %q", prompt, want)
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
