package main

import (
	"context"
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"strings"
	"testing"
)

func TestRunPruneImagesE_gateAbortsWithAnyManagedContainer(t *testing.T) {
	// A stopped container and a running container both block: force-removing
	// a running container's image is a hard Docker conflict (-f cannot force)
	// and force-removing a stopped one silently orphans it. The gate is
	// state-agnostic by construction — both states exercise the same abort.
	resetPruneState(t)
	for _, state := range []string{"stopped", "running"} {
		calls := pruneTestStub(t, []string{"cheasee-pi-repoA"}, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\n", "")
		err := runPruneImagesE(pruneImagesCmd, nil)
		if err == nil || !strings.Contains(err.Error(), "cheasee-pi clean") {
			t.Fatalf("%s container: gate must abort pointing at `cheasee-pi clean`, got %v", state, err)
		}
		assertNoMutations(t, calls)
	}
}

func TestRunPruneImagesE_yesNeverBypassesGate(t *testing.T) {
	resetPruneState(t)
	pruneImagesYes = true
	calls := pruneTestStub(t, []string{"cheasee-pi-repoA"}, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\n", "")
	err := runPruneImagesE(pruneImagesCmd, nil)
	if err == nil || !strings.Contains(err.Error(), "cheasee-pi clean") {
		t.Fatalf("--yes must not bypass the gate, got %v", err)
	}
	assertNoMutations(t, calls)
}

func TestRunPruneImagesE_gateFailureSurfaces(t *testing.T) {
	resetPruneState(t)
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
		}
		return &mockCmd{}
	})
	err := runPruneImagesE(pruneImagesCmd, nil)
	if err == nil || !strings.Contains(err.Error(), "prune-images:") || !strings.Contains(err.Error(), "daemon down") {
		t.Fatalf("gate failure must surface wrapped, got %v", err)
	}
}

func TestRunPruneImagesE_enumerationFailureSurfaces(t *testing.T) {
	resetPruneState(t)
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		if len(arg) > 1 && arg[0] == "image" && arg[1] == "ls" {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
		}
		return &mockCmd{}
	})
	err := runPruneImagesE(pruneImagesCmd, nil)
	if err == nil || !strings.Contains(err.Error(), "enumerate images") {
		t.Fatalf("enumeration failure must surface wrapped, got %v", err)
	}
}

func TestRunPruneImagesE_dryRunListsImages(t *testing.T) {
	resetPruneState(t)
	pruneImagesDryRun = true
	calls := pruneTestStub(t, nil, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\ncheasee-pi-repoA-codeflow:latest|1.2GB\n", "")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	for _, want := range []string{
		"cheasee-pi-repoA-cheasee-pi:latest", "cheasee-pi-repoA-codeflow:latest",
		"3.4GB", "1.2GB", "≈", "Dry-run",
	} {
		if !strings.Contains(stderr, want) {
			t.Errorf("dry-run must report %q, got %q", want, stderr)
		}
	}
	assertNoMutations(t, calls)
}

func TestRunPruneImagesE_dryRunNoImages(t *testing.T) {
	resetPruneState(t)
	pruneImagesDryRun = true
	calls := pruneTestStub(t, nil, "", "")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	if !strings.Contains(stderr, "No cheasee-pi images found") {
		t.Errorf("dry-run with zero images must say so, got %q", stderr)
	}
	if !strings.Contains(stderr, "Dry-run") {
		t.Errorf("dry-run must still be reported, got %q", stderr)
	}
	assertNoMutations(t, calls)
}
