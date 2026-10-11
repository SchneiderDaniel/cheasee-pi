package main

import (
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"slices"
	"strings"
	"testing"
)

func TestRunPruneImagesE_yesOrdersRemoveThenPrune(t *testing.T) {
	// Cache reclaim only works after the tagged images that pinned it are
	// gone: every image rm precedes image prune, which precedes buildx -a.
	resetPruneState(t)
	pruneImagesYes = true
	calls := pruneTestStub(t, nil, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\ncheasee-pi-repoA-codeflow:latest|1.2GB\n", "")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	if !strings.Contains(stderr, "Removed image cheasee-pi-repoA-cheasee-pi:latest") {
		t.Errorf("--yes run must remove the first ref, got %q", stderr)
	}
	if !strings.Contains(stderr, "Pruned dangling Docker images") {
		t.Errorf("--yes run must prune dangling images, got %q", stderr)
	}
	if !strings.Contains(stderr, "Pruned Docker build cache (all projects)") {
		t.Errorf("--yes run must prune the build cache host-wide, got %q", stderr)
	}

	lastRm, pruneIdx, buildxIdx := -1, -1, -1
	for i, arg := range *calls {
		switch {
		case len(arg) > 1 && arg[0] == "image" && arg[1] == "rm":
			lastRm = i
		case len(arg) > 1 && arg[0] == "image" && arg[1] == "prune":
			pruneIdx = i
		case len(arg) > 0 && arg[0] == "buildx" && slices.Contains(arg, "-a"):
			buildxIdx = i
		}
	}
	if lastRm == -1 || pruneIdx == -1 || buildxIdx == -1 {
		t.Fatalf("expected image rm, image prune and buildx prune -a calls, got %v", *calls)
	}
	if lastRm >= pruneIdx {
		t.Errorf("every image rm must precede image prune (lastRm=%d, pruneIdx=%d)", lastRm, pruneIdx)
	}
	if pruneIdx >= buildxIdx {
		t.Errorf("image prune must precede buildx prune -a (pruneIdx=%d, buildxIdx=%d)", pruneIdx, buildxIdx)
	}
}

func TestRunPruneImagesE_rmFailureSurfaces(t *testing.T) {
	resetPruneState(t)
	pruneImagesYes = true
	calls := pruneTestStub(t, nil, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\ncheasee-pi-repoA-codeflow:latest|1.2GB\n", "cheasee-pi-repoA-codeflow:latest")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			if !strings.Contains(err.Error(), "cheasee-pi-repoA-codeflow:latest") {
				t.Errorf("error must name the failed ref, got %v", err)
			}
			return
		}
		t.Error("rm failure must surface as an error")
	})
	// No success summary for the full run: mutation stops mid-loop.
	if strings.Contains(stderr, "Pruned Docker build cache") {
		t.Errorf("failed run must not prune the cache, got %q", stderr)
	}
	for _, arg := range *calls {
		if len(arg) > 0 && arg[0] == "buildx" {
			t.Errorf("failed run must not reach buildx prune, got %v", arg)
		}
	}
}
