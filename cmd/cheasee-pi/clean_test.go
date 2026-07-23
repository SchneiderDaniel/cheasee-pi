package main

import (
	"os"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Unit: cleanCmd help text
// ──────────────────────────────────────────────

func TestCleanCmd_LongHelp(t *testing.T) {
	help := cleanCmd.Long
	if !strings.Contains(help, "orphaned") {
		t.Errorf("cleanCmd.Long should mention 'orphaned', got:\n%s", help)
	}
	if strings.Contains(help, "ALL pi") {
		t.Errorf("cleanCmd.Long should NOT mention 'ALL pi' (behavior changed to orphans-only), got:\n%s", help)
	}
	if !strings.Contains(help, "interactive sessions are NOT affected") {
		t.Errorf("cleanCmd.Long should clarify interactive sessions are spared, got:\n%s", help)
	}
}

// ──────────────────────────────────────────────
// Unit: cleanCmd.Short
// ──────────────────────────────────────────────

func TestCleanCmd_Short(t *testing.T) {
	short := cleanCmd.Short
	if !strings.Contains(short, "orphaned") {
		t.Errorf("cleanCmd.Short should mention 'orphaned', got: %q", short)
	}
}

// ──────────────────────────────────────────────
// Adapter: runCleanE delegates to pi-guardian --once
// (exec.Command call signature test — no Docker daemon needed)
// ──────────────────────────────────────────────

// TestCleanCmd_UsesPiGuardian verifies that runCleanE
// constructs a docker exec pi-guardian --once command by reading
// the actual source code of clean.go.

func TestCleanCmd_UsesPiGuardian(t *testing.T) {
	content := readCleanGoForTest(t)
	if !strings.Contains(content, "pi-guardian --once") {
		t.Errorf("clean.go must delegate to 'pi-guardian --once', but we found:\n%s", content)
	}
	if strings.Contains(content, "for d in /proc/") {
		t.Errorf("clean.go must NOT contain old /proc loop, but still has it:\n%s", content)
	}
}

// readCleanGoForTest returns the content of clean.go by reading it from disk.
func readCleanGoForTest(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("clean.go")
	if err != nil {
		t.Fatalf("read clean.go: %v", err)
	}
	return string(data)
}
