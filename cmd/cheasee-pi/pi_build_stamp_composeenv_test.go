package main

import (
	"strconv"
	"strings"
	"testing"
)

// assertOnePiBuildStamp asserts exactly one PI_BUILD_STAMP entry and returns
// its value — duplicate entries resolve nondeterministically, and an inherited
// value must never win over the CLI-owned one.

func assertOnePiBuildStamp(t *testing.T, env []string) string {
	t.Helper()
	var hits []string
	for _, e := range env {
		if k, v, ok := strings.Cut(e, "="); ok && k == "PI_BUILD_STAMP" {
			hits = append(hits, v)
		}
	}
	if len(hits) != 1 {
		t.Fatalf("exactly one PI_BUILD_STAMP entry expected, got %v", hits)
	}
	return hits[0]
}

func TestApplyComposeEnv_PiBuildStampOneEntry(t *testing.T) {
	t.Setenv("PI_BUILD_STAMP", "")
	workdir := t.TempDir()
	cmd := &mockCmd{}
	applyComposeEnv(cmd, workdir, containerName(workdir), t.TempDir())

	stamp := assertOnePiBuildStamp(t, cmd.env)
	if stamp == "" {
		t.Fatal("PI_BUILD_STAMP must be non-empty (cache-busting contract)")
	}
	if _, err := strconv.Atoi(stamp); err != nil {
		t.Errorf("PI_BUILD_STAMP must be unix seconds (all digits), got %q", stamp)
	}
}

func TestApplyComposeEnv_PiBuildStampReplacesInherited(t *testing.T) {
	// An inherited PI_BUILD_STAMP must be stripped and replaced by the
	// CLI-owned value (proves stripEnvKeys gained the key).
	t.Setenv("PI_BUILD_STAMP", "stale")
	workdir := t.TempDir()
	cmd := &mockCmd{}
	applyComposeEnv(cmd, workdir, containerName(workdir), t.TempDir())

	stamp := assertOnePiBuildStamp(t, cmd.env)
	if stamp == "stale" || stamp == "" {
		t.Errorf("CLI-owned PI_BUILD_STAMP must replace the inherited value, got %q", stamp)
	}
}
