package main

import (
	"context"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

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
