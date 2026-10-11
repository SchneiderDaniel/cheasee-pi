package main

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

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
