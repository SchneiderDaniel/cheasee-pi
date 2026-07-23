package main

import (
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Unit: execArgs
// ──────────────────────────────────────────────

func TestExecArgs_ContainsSetM(t *testing.T) {
	args := execArgs(nil, "test-container")
	script := extractBashScript(t, args)
	if !strings.Contains(script, "set -m") {
		t.Errorf("execArgs bash script should contain 'set -m' (monitor mode), got:\n%s", script)
	}
}

func TestExecArgs_ContainsProcessGroupKill(t *testing.T) {
	args := execArgs(nil, "test-container")
	script := extractBashScript(t, args)
	if !strings.Contains(script, "kill -- -$P1 -- -$P2") {
		t.Errorf("execArgs bash script should kill process groups (kill -- -$P1 -- -$P2), got:\n%s", script)
	}
	if strings.Contains(script, "kill $P1 $P2") {
		t.Errorf("execArgs bash script should NOT have old-style kill $P1 $P2, got:\n%s", script)
	}
}

func TestExecArgs_ContainsTrap(t *testing.T) {
	args := execArgs(nil, "test-container")
	script := extractBashScript(t, args)
	if !strings.Contains(script, "trap") {
		t.Errorf("execArgs bash script should contain trap for signal handling, got:\n%s", script)
	}
	if !strings.Contains(script, "INT TERM HUP") {
		t.Errorf("execArgs bash script should trap INT TERM HUP, got:\n%s", script)
	}
}

func TestExecArgs_Format(t *testing.T) {
	args := execArgs(nil, "my-container")
	joined := strings.Join(args, " ")
	// Should start with "exec" and contain the container name and bash -c
	if len(args) < 6 {
		t.Errorf("execArgs returned too few args (%d): %v", len(args), args)
	}
	hasExec := false
	hasContainer := false
	hasBashC := false
	for i, a := range args {
		if a == "exec" {
			hasExec = true
		}
		if a == "my-container" {
			hasContainer = true
		}
		if a == "bash" && i+1 < len(args) && args[i+1] == "-c" {
			hasBashC = true
		}
	}
	if !hasExec {
		t.Errorf("execArgs should contain 'exec', got: %s", joined)
	}
	if !hasContainer {
		t.Errorf("execArgs should contain container name, got: %s", joined)
	}
	if !hasBashC {
		t.Errorf("execArgs should contain 'bash -c', got: %s", joined)
	}
}

func TestExecArgs_WithEnvFlags(t *testing.T) {
	envFlags := []string{"-e", "OPENAI_API_KEY=sk-test", "-e", "ANTHROPIC_API_KEY=sk-ant"}
	args := execArgs(envFlags, "test-container")
	joined := strings.Join(args, " ")
	// Env flags should appear before -it --user -w
	execIdx := indexOf(args, "exec")
	itIdx := indexOf(args, "-it")
	if execIdx < 0 || itIdx < 0 {
		t.Fatalf("execArgs missing 'exec' or '-it': %v", args)
	}
	// -e flags should be between exec and -it (since envFlags are spliced into exec args)
	for _, flag := range envFlags {
		if !strings.Contains(joined, flag) {
			t.Errorf("execArgs should contain env flag %q, got: %s", flag, joined)
		}
	}
}

func TestExecArgs_EmptyEnvFlags(t *testing.T) {
	args := execArgs(nil, "test-container")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--user agentuser") {
		t.Errorf("execArgs should contain --user agentuser, got: %s", joined)
	}
	if !strings.Contains(joined, "-w /workspaces/main") {
		t.Errorf("execArgs should contain -w /workspaces/main, got: %s", joined)
	}
	if !strings.Contains(joined, "test-container") {
		t.Errorf("execArgs should contain container name, got: %s", joined)
	}
	if !strings.Contains(joined, "pi --approve") {
		t.Errorf("execArgs bash script should contain /usr/bin/pi --approve, got: %s", joined)
	}
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

// extractBashScript pulls the bash -c script from execArgs output.
func extractBashScript(t *testing.T, args []string) string {
	t.Helper()
	for i, a := range args {
		if a == "bash" && i+2 < len(args) && args[i+1] == "-c" {
			return args[i+2]
		}
	}
	t.Fatalf("no bash -c script found in execArgs: %v", args)
	return ""
}

func indexOf(items []string, target string) int {
	for i, item := range items {
		if item == target {
			return i
		}
	}
	return -1
}
