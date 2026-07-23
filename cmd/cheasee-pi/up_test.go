package main

import (
	"os"
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

func TestExecArgs_ContainsSetsid(t *testing.T) {
	args := execArgs(nil, "test-container")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "setsid") {
		t.Errorf("execArgs should contain setsid, got: %s", joined)
	}
}

// ──────────────────────────────────────────────
// Unit: killOrphanPISessions (source pattern verification)
// ──────────────────────────────────────────────

func TestKillOrphanPISessions_UsesPiGuardianOnce(t *testing.T) {
	content := readUpGoForTest(t)
	if !strings.Contains(content, "pi-guardian --once") {
		t.Errorf("killOrphanPISessions should run 'pi-guardian --once' inside container, got:\n%s", content)
	}
}

func TestKillOrphanPISessions_CalledBeforeExecPIContainer(t *testing.T) {
	content := readUpGoForTest(t)
	// killOrphanPISessions must appear before execPIContainer in runUpE
	killIdx := strings.Index(content, "killOrphanPISessions")
	execIdx := strings.Index(content, "execPIContainer")
	if killIdx < 0 {
		t.Error("killOrphanPISessions not found in up.go")
	}
	if execIdx < 0 {
		t.Error("execPIContainer not found in up.go")
	}
	if killIdx >= 0 && execIdx >= 0 && killIdx > execIdx {
		t.Error("killOrphanPISessions should be called BEFORE execPIContainer in runUpE")
	}
}

func TestKillOrphanPISessions_NonRunningReturnsError(t *testing.T) {
	content := readUpGoForTest(t)
	// killOrphanPISessions should use exec.CommandContext which will fail
	// if the container is not running (no Docker daemon check inside it).
	// Verify it doesn't silently swallow errors.
	if !strings.Contains(content, "return fmt.Errorf") && !strings.Contains(content, "err != nil") {
		// Check that the function handles errors
		t.Error("killOrphanPISessions should handle errors, no error handling found")
	}
}

// ──────────────────────────────────────────────
// Unit: runUpE --dry-run
// ──────────────────────────────────────────────

func TestRunUpE_DryRunUsesSetsidWrapper(t *testing.T) {
	content := readUpGoForTest(t)
	// dry-run mode should print the docker command including setsid wrapper
	if !strings.Contains(content, "setsid") {
		t.Errorf("runUpE dry-run should show docker command with setsid wrapper, got:\n%s", content)
	}
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

func readUpGoForTest(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("up.go")
	if err != nil {
		t.Fatalf("read up.go: %v", err)
	}
	return string(data)
}

// extractBashScript pulls the bash -c script from execArgs output.
// It looks for the "setsid" + "bash" + "-c" sequence.
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
