package main

import (
	"context"
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"slices"
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

func TestRunPruneImagesE_dryRunYesComboStaysReportOnly(t *testing.T) {
	const imageLS = "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\n"

	// --dry-run alone.
	resetPruneState(t)
	pruneImagesDryRun = true
	dryCalls := pruneTestStub(t, nil, imageLS, "")
	dryStderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	assertNoMutations(t, dryCalls)

	// --dry-run --yes: byte-identical to --dry-run alone (dry-run wins).
	resetPruneState(t)
	pruneImagesDryRun = true
	pruneImagesYes = true
	comboCalls := pruneTestStub(t, nil, imageLS, "")
	comboStderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	if comboStderr != dryStderr {
		t.Errorf("--dry-run --yes must match dry-run alone:\ncombo:   %q\ndry-run: %q", comboStderr, dryStderr)
	}
	assertNoMutations(t, comboCalls)
}

func TestRunPruneImagesE_confirmAbortTouchesNothing(t *testing.T) {
	resetPruneState(t)
	pruneImagesConfirmFn = func(string) (bool, error) { return false, nil }
	calls := pruneTestStub(t, nil, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\n", "")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	if !strings.Contains(stderr, "Aborted") {
		t.Errorf("abort must be reported, got %q", stderr)
	}
	if strings.Contains(stderr, "Removed image") {
		t.Errorf("aborted run must not remove images, got %q", stderr)
	}
	assertNoMutations(t, calls)
}

func TestRunPruneImagesE_confirmPromptDisclosesCountAndCache(t *testing.T) {
	resetPruneState(t)
	var prompt string
	pruneImagesConfirmFn = func(p string) (bool, error) { prompt = p; return false, nil }
	pruneTestStub(t, nil, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\ncheasee-pi-repoA-codeflow:latest|1.2GB\n", "")
	testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	if !strings.Contains(prompt, "2") {
		t.Errorf("prompt must state the image count, got %q", prompt)
	}
	if !strings.Contains(prompt, "cache") {
		t.Errorf("prompt must disclose the host-wide cache blast radius, got %q", prompt)
	}
}

func TestRunPruneImagesE_confirmRemovesAllImages(t *testing.T) {
	// No keep-latest: every tagged image is removed, newest and oldest alike.
	resetPruneState(t)
	pruneImagesConfirmFn = func(string) (bool, error) { return true, nil }
	calls := pruneTestStub(t, nil, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\ncheasee-pi-repoA-cheasee-pi:v2|0.9GB\n", "")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	for _, ref := range []string{"cheasee-pi-repoA-cheasee-pi:latest", "cheasee-pi-repoA-cheasee-pi:v2"} {
		if !strings.Contains(stderr, "Removed image "+ref) {
			t.Errorf("confirmed run must remove %s, got %q", ref, stderr)
		}
	}
	var rmRefs []string
	for _, arg := range *calls {
		if len(arg) > 1 && arg[0] == "image" && arg[1] == "rm" {
			rmRefs = append(rmRefs, arg[len(arg)-1])
		}
	}
	if len(rmRefs) != 2 {
		t.Errorf("expected exactly 2 image rm calls, got %v", rmRefs)
	}
}

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

func TestRunPruneImagesE_rerunEmptyIsIdempotent(t *testing.T) {
	resetPruneState(t)
	pruneImagesYes = true
	calls := pruneTestStub(t, nil, "", "")
	testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("re-run after everything is gone must succeed, got %v", err)
		}
	})
	for _, arg := range *calls {
		if len(arg) > 1 && arg[0] == "image" && arg[1] == "rm" {
			t.Errorf("empty enumeration must issue zero image rm, got %v", arg)
		}
	}
}

// ──────────────────────────────────────────────
// Phase 3: operator journey via rootCmd
// ──────────────────────────────────────────────
