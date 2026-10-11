package main

import (
	"context"
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"slices"
	"strings"
	"testing"
)

func TestRemoveImages_RemovesEachRefInOrder(t *testing.T) {
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		return &mockCmd{}
	})

	images := []cheaseePiImage{
		{Ref: "cheasee-pi-repoA-cheasee-pi:latest"},
		{Ref: "cheasee-pi-repoA-codeflow:latest"},
	}
	stderr := testutil.CaptureStderr(t, func() {
		if err := removeImages(context.Background(), images); err != nil {
			t.Fatalf("removeImages: %v", err)
		}
	})

	want := [][]string{
		{"image", "rm", "-f", "cheasee-pi-repoA-cheasee-pi:latest"},
		{"image", "rm", "-f", "cheasee-pi-repoA-codeflow:latest"},
	}
	if len(recorded) != 2 || !slices.Equal(recorded[0], want[0]) || !slices.Equal(recorded[1], want[1]) {
		t.Errorf("docker invocations = %v, want %v", recorded, want)
	}
	for _, ref := range []string{"cheasee-pi-repoA-cheasee-pi:latest", "cheasee-pi-repoA-codeflow:latest"} {
		if !strings.Contains(stderr, "Removed image "+ref) {
			t.Errorf("removal confirmation missing for %s, got %q", ref, stderr)
		}
	}
}

func TestRemoveImages_EmptyIsNoop(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		t.Errorf("no docker invocation expected for empty refs, got %v %v", name, arg)
		return &mockCmd{}
	})
	if err := removeImages(context.Background(), nil); err != nil {
		t.Fatalf("removeImages(nil): %v", err)
	}
}

func TestRemoveImages_FailureAborts(t *testing.T) {
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		if slices.Contains(arg, "cheasee-pi-repoB-codeflow:latest") {
			return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("conflict") }}
		}
		return &mockCmd{}
	})

	images := []cheaseePiImage{
		{Ref: "cheasee-pi-repoA-cheasee-pi:latest"},
		{Ref: "cheasee-pi-repoB-codeflow:latest"},
		{Ref: "cheasee-pi-repoC-cheasee-pi:latest"},
	}
	err := removeImages(context.Background(), images)
	if err == nil || !strings.Contains(err.Error(), "cheasee-pi-repoB-codeflow:latest") {
		t.Fatalf("rm failure must surface naming the ref, got %v", err)
	}
	// Abort, no silent partial clean: the third ref is never attempted.
	if len(recorded) != 2 {
		t.Errorf("failed rm must stop the loop (2 calls), got %d: %v", len(recorded), recorded)
	}
}

func TestPruneBuildCache_AllInvokesWithA(t *testing.T) {
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		return &mockCmd{}
	})
	if err := pruneBuildCache(context.Background(), true); err != nil {
		t.Fatalf("pruneBuildCache(all): %v", err)
	}
	if len(recorded) != 1 || !slices.Equal(recorded[0], []string{"buildx", "prune", "-a", "-f"}) {
		t.Errorf("pruneBuildCache(all=true) must invoke docker buildx prune -a -f, got %v", recorded)
	}
}

func TestPruneBuildCache_AllFailureSurfaces(t *testing.T) {
	// A docker failure must surface as an error — never silent success while
	// the cache the removed images pinned stays on disk.
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
	})
	err := pruneBuildCache(context.Background(), true)
	if err == nil || !strings.Contains(err.Error(), "docker buildx prune") || !strings.Contains(err.Error(), "daemon down") {
		t.Fatalf("buildx prune failure must surface wrapped, got %v", err)
	}
}

func TestPruneBuildCache_InvokesWithoutA(t *testing.T) {
	// Regression: clean's cache blast radius is unchanged — no -a added.
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		return &mockCmd{}
	})
	if err := pruneBuildCache(context.Background(), false); err != nil {
		t.Fatalf("pruneBuildCache: %v", err)
	}
	if len(recorded) != 1 || !slices.Equal(recorded[0], []string{"buildx", "prune", "-f"}) {
		t.Errorf("pruneBuildCache must invoke docker buildx prune -f (no -a), got %v", recorded)
	}
}

// ──────────────────────────────────────────────
// Phase 2: runPruneImagesE orchestration
// ──────────────────────────────────────────────
