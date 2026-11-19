package main

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Shared fixtures for the credential drift checks (Phase 5)
// ──────────────────────────────────────────────

// authInspectDoc builds the `docker inspect --format '{{json .}}'` document for
// the AGENT container: the given credential stamp label ("" → label-less, the
// pre-change read-write-mount container) plus a running state.
func authInspectDoc(stamp string) map[string]any {
	labels := map[string]string{managedLabel: "true"}
	if stamp != "" {
		labels[authSpecLabel] = stamp
	}
	return map[string]any{
		"Config": map[string]any{"Labels": labels},
		"State":  map[string]any{"Running": true, "StartedAt": "2024-01-01T00:00:00Z"},
	}
}

// authInspectJSON marshals a live-container doc for the inspect seam.
func authInspectJSON(doc map[string]any) string {
	b, err := json.Marshal(doc)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// authInspectRunner answers the drift `docker inspect --format '{{json .}}'`
// seam call with a live-container document (CombinedOutput, so combinedFn).
func authInspectRunner(out string) runner {
	return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(out), nil }}
}

// liveAuthSpec is the stamp a freshly written fixture auth.json stamps to.
func liveAuthSpec(t *testing.T, path string) string {
	t.Helper()
	spec, err := authSpec(path)
	if err != nil {
		t.Fatalf("authSpec(%s): %v", path, err)
	}
	return spec
}

// legacyStoppedInspectFn answers both inspect seams for a container that
// predates the read-only credential mount: a label-less credential stamp on the
// drift probe, a healthy status on the ready probe.
func legacyStoppedInspectFn(_ context.Context, arg []string) runner {
	if slices.Contains(arg, "{{json .}}") {
		return authInspectRunner(authInspectJSON(authInspectDoc("")))
	}
	return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
}

// readyHealthInspectFn is the ready probe alone (no drift answer): a container
// created on this run is never drift-checked.
func readyHealthInspectFn(_ context.Context, _ []string) runner {
	return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy"), nil }}
}

// wantSubstrings fails the test unless every want appears verbatim in got.
func wantSubstrings(t *testing.T, got string, want ...string) {
	t.Helper()
	for _, w := range want {
		if !strings.Contains(got, w) {
			t.Errorf("output must contain %q, got: %q", w, got)
		}
	}
}

// stubDockerInspect answers every docker inspect call with out/err.
func stubDockerInspect(t *testing.T, out string, err error) {
	t.Helper()
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "inspect" {
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(out), err }}
		}
		return &mockCmd{}
	})
}
