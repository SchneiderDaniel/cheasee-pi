package main

import (
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"testing"
)

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
