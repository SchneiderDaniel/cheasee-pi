package main

import (
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"strings"
	"testing"
)

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
