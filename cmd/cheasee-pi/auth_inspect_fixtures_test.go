package main

import (
	"context"
	"encoding/json"
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
