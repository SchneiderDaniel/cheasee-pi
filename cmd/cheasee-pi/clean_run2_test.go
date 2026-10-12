package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

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
