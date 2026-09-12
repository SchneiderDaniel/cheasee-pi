package main

import (
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// memoryLimitEnv (up/build shared reader, cheasee-settings.json)
// ──────────────────────────────────────────────

func TestMemoryLimitEnv_present(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"docker": {"memory": "4G"}}`)
	env, ok := memoryLimitEnv(workdir)
	if !ok {
		t.Fatal("expected ok=true for docker.memory=4G")
	}
	if env != "CHEASEEPI_MEMORY=4G" {
		t.Errorf("env = %q, want CHEASEEPI_MEMORY=4G", env)
	}
}

func TestMemoryLimitEnv_missingFileSilent(t *testing.T) {
	workdir := t.TempDir()
	env, ok := memoryLimitEnv(workdir)
	if ok || env != "" {
		t.Errorf("missing file: want (\"\", false), got (%q, %v)", env, ok)
	}
}

func TestMemoryLimitEnv_corruptWarns(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, "{nope")

	var (
		env string
		ok  bool
	)
	stderr := testutil.CaptureStderr(t, func() { env, ok = memoryLimitEnv(workdir) })

	if ok || env != "" {
		t.Errorf("corrupt JSON: want (\"\", false), got (%q, %v)", env, ok)
	}
	if !strings.Contains(stderr, "cheasee-settings.json") {
		t.Errorf("corrupt JSON must warn on stderr, got: %q", stderr)
	}
}

func TestMemoryLimitEnv_emptyMemory(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"docker": {"memory": ""}}`)
	if env, ok := memoryLimitEnv(workdir); ok || env != "" {
		t.Errorf("empty memory: want (\"\", false), got (%q, %v)", env, ok)
	}
}

func TestMemoryLimitEnv_noDockerSection(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider": "openai"}`)
	if env, ok := memoryLimitEnv(workdir); ok || env != "" {
		t.Errorf("no docker section: want (\"\", false), got (%q, %v)", env, ok)
	}
}
