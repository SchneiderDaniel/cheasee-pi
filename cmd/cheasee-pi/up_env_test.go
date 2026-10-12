package main

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"testing"
)

// Build-env flag mapping, docker exec arg construction, provider
// passthrough and env redaction. Moved verbatim from up_test.go.
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// execArgs tests — Phase 1
// ──────────────────────────────────────────────

func TestExecArgs_runsPiDirectly(t *testing.T) {
	args := execArgs(nil, "cheasee-pi", "/workspaces/main")
	joined := strings.Join(args, " ")

	checks := []string{
		"/usr/bin/pi",
		"--approve",
	}
	for _, want := range checks {
		if !strings.Contains(joined, want) {
			t.Errorf("execArgs missing %q", want)
		}
	}

	// No bash wrapper — docker exec handles cleanup on disconnect
	for _, banned := range []string{"bash -c", "setsid", "trap"} {
		if strings.Contains(joined, banned) {
			t.Errorf("execArgs should not have wrapper script (%s)", banned)
		}
	}
}

func TestExecArgs_containsExpectedOrder(t *testing.T) {
	args := execArgs(nil, "cheasee-pi", "/workspaces/main")
	joined := strings.Join(args, " ")

	checks := []string{
		"exec",
		"-it",
		"--user agentuser",
		"-w /workspaces/main",
		"cheasee-pi",
		"/usr/bin/pi",
	}
	for _, want := range checks {
		if !strings.Contains(joined, want) {
			t.Errorf("execArgs missing %q", want)
		}
	}
}

func TestExecArgs_envFlagsInCorrectPosition(t *testing.T) {
	env := map[string]string{"FOO": "bar", "BAZ": "qux"}
	args := execArgs(env, "cheasee-pi", "/workspaces/main")

	execIdx := indexOfArg(args, "exec")
	nameIdx := indexOfArg(args, "cheasee-pi")
	envEIdx := indexOfArg(args, "-e")

	if envEIdx < execIdx {
		t.Errorf("-e flag at %d before exec at %d", envEIdx, execIdx)
	}
	if envEIdx > nameIdx {
		t.Errorf("-e flag at %d after container name at %d", envEIdx, nameIdx)
	}

	// pairs flattened verbatim, sorted by key (BAZ < FOO)
	want := []string{"BAZ=qux", "FOO=bar"}
	for i := 0; i < len(want); i++ {
		idx := envEIdx + 2*i
		if args[idx] != "-e" || args[idx+1] != want[i] {
			t.Errorf("args[%d:%d] = %v, want [-e %s]", idx, idx+2, args[idx:idx+2], want[i])
		}
	}
}

func TestExecArgs_emptyEnvFlags(t *testing.T) {
	args := execArgs(nil, "cheasee-pi", "/workspaces/main")
	if len(args) < 6 {
		t.Fatalf("execArgs returned too few args: %v", args)
	}
	if args[0] != "exec" {
		t.Errorf("expected first arg exec, got %q", args[0])
	}
	for _, a := range args {
		if a == "-e" {
			t.Errorf("empty env map should emit no -e flags, got %v", args)
		}
	}
}

func TestExecArgs_manyEnvFlags(t *testing.T) {
	env := make(map[string]string)
	for i := 0; i < 20; i++ {
		env[fmt.Sprintf("KEY_%02d", i)] = fmt.Sprintf("val_%d", i)
	}
	args := execArgs(env, "cheasee-pi", "/workspaces/main")

	namePos := -1
	for i, a := range args {
		if a == "cheasee-pi" {
			namePos = i
			break
		}
	}
	if namePos < 0 {
		t.Fatal("container name not found")
	}

	// -e count == 2×len(map), each pair verbatim and before the container name
	// (1×"exec" + 2n env flags + "-it --user agentuser -w /workspaces/main")
	if namePos != 6+2*len(env) {
		t.Fatalf("expected %d args before container name, got %d: %v", 6+2*len(env), namePos, args)
	}
	for i, k := range slices.Sorted(maps.Keys(env)) {
		idx := 1 + 2*i
		if args[idx] != "-e" || args[idx+1] != k+"="+env[k] {
			t.Errorf("args[%d:%d] = %v, want [-e %s]", idx, idx+2, args[idx:idx+2], k+"="+env[k])
		}
	}
}

func TestExecArgs_sortedFlattenIsDeterministic(t *testing.T) {
	env := make(map[string]string)
	for i := 0; i < 25; i++ {
		env[fmt.Sprintf("KEY_%02d", i)] = fmt.Sprintf("val_%d", i)
	}
	first := execArgs(env, "cheasee-pi", "/workspaces/main")
	for i := 0; i < 10; i++ {
		if got := execArgs(env, "cheasee-pi", "/workspaces/main"); !slices.Equal(got, first) {
			t.Fatalf("execArgs not deterministic on iteration %d:\n first: %v\n got:   %v", i, first, got)
		}
	}
}

func TestExecArgs_valuesSurviveUnescaped(t *testing.T) {
	env := map[string]string{"WEIRD": "a=b c$d"}
	args := execArgs(env, "cheasee-pi", "/workspaces/main")
	if !slices.Contains(args, "WEIRD=a=b c$d") {
		t.Errorf("value with spaces/$/= must survive as a single argv element: %v", args)
	}
}

// TestExecArgs_pinsSessionIDPair keeps the terminal and the UI on one join
// key: the pi child must carry `--session-id <CHEASEE_SESSION_ID>` so the
// shared-mount claim, the reaper, and the session file all agree.
func TestExecArgs_pinsSessionIDPair(t *testing.T) {
	env := map[string]string{"CHEASEE_SESSION_ID": "deadbeef"}
	args := execArgs(env, "cheasee-pi", "/workspaces/main")
	i := indexOfArg(args, "--session-id")
	if i < 0 || i+1 >= len(args) {
		t.Fatalf("execArgs must pin --session-id <marker>, got %v", args)
	}
	if args[i+1] != "deadbeef" {
		t.Errorf("--session-id value = %q, want the session marker", args[i+1])
	}
	if !slices.Contains(args, "-e") || !slices.Contains(args, "CHEASEE_SESSION_ID=deadbeef") {
		t.Errorf("the env marker and the flag must both be present: %v", args)
	}
	// No marker → no flag (tests and legacy callers pass a bare env map).
	if slices.Contains(execArgs(nil, "cheasee-pi", "/workspaces/main"), "--session-id") {
		t.Error("an absent marker must not emit --session-id")
	}
}

// ──────────────────────────────────────────────
// orphanScanBash tests — Phase 2
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

func indexOfArg(slice []string, val string) int {
	for i, s := range slice {
		if s == val {
			return i
		}
	}
	return -1
}
