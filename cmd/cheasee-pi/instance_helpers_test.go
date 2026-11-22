package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Shared fixtures and assertions for the discovery suite
//
// One home for the fail-fast helpers every `TestDiscovery_*` file uses: they
// keep a scenario readable (one line per assertion) and keep each sibling
// module under the complexity/god-object ceilings the repo enforces.
// ──────────────────────────────────────────────

// instanceKeyPattern is the docker/compose charset contract: lowercase
// alphanumerics plus '-'/'_', never a leading separator (compose ≥ v2.17
// rejects anything else, and a leading '-' reads as a flag to docker).
var instanceKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

// discoveryRequireNoErr fails the test with context when err is non-nil.
func discoveryRequireNoErr(t *testing.T, what string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", what, err)
	}
}

// discoveryRequireAbsent asserts that path does not exist.
func discoveryRequireAbsent(t *testing.T, what, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("%s must not exist (%s), stat err = %v", what, path, err)
	}
}

// discoveryRequireContains asserts that text carries every want fragment.
func discoveryRequireContains(t *testing.T, what, text string, want ...string) {
	t.Helper()
	for _, fragment := range want {
		if !strings.Contains(text, fragment) {
			t.Errorf("%s must name %q, got %q", what, fragment, text)
		}
	}
}

// discoveryRecord is a complete registry record for adapter tests.
func discoveryRecord(key string) InstanceRecord {
	return InstanceRecord{
		Key:            key,
		Label:          "alice-foo (ws1)",
		UIPort:         "9501",
		CodeflowPort:   "8471",
		StartedAt:      "2024-01-02T03:04:05Z",
		AgentContainer: containerNameFromKey(key),
	}
}

// discoveryList lists the registry, failing the test on error.
func discoveryList(t *testing.T, reg InstanceRegistry) []InstanceRecord {
	t.Helper()
	got, err := reg.List()
	discoveryRequireNoErr(t, "List", err)
	return got
}

// discoveryRequireRecordCount lists the registry and asserts the entry count.
func discoveryRequireRecordCount(t *testing.T, reg InstanceRegistry, want int) []InstanceRecord {
	t.Helper()
	got := discoveryList(t, reg)
	if len(got) != want {
		t.Fatalf("List = %v, want %d record(s)", got, want)
	}
	return got
}

// mustRegistryDir resolves the registry dir for a test that already pinned
// XDG_CACHE_HOME.
func mustRegistryDir(t *testing.T) string {
	t.Helper()
	dir, err := instanceRegistryDir()
	discoveryRequireNoErr(t, "instanceRegistryDir", err)
	return dir
}

// discoverySnapshotPath is a temp-dir snapshot target.
func discoverySnapshotPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "instances.json")
}

// readSnapshot decodes the snapshot file into raw entries.
func readSnapshot(t *testing.T, path string) []map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	discoveryRequireNoErr(t, "read snapshot", err)
	var doc []map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("snapshot is not JSON (%s): %v", raw, err)
	}
	return doc
}

// discoveryRequirePort asserts that a resolved host port stays inside its band.
func discoveryRequirePort(t *testing.T, what, value string, low, high int) {
	t.Helper()
	port, convErr := strconv.Atoi(value)
	discoveryRequireNoErr(t, what+" port must be numeric: "+value, convErr)
	if port < low || port > high {
		t.Errorf("%s port %d outside [%d, %d]", what, port, low, high)
	}
}
