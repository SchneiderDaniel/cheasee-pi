package main

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// execRunner adapter contract tests — the only place the merged seam is
// exercised against real os/exec (sh/pwd/cat/true only; no docker, no git).
// Every docker/git production site is stubbed in its own use-case tests.

// ──────────────────────────────────────────────
// Field wiring (SetDir/SetEnv/SetStdin/SetStdout/SetStderr)
// ──────────────────────────────────────────────

func TestExecRunner_SetDir(t *testing.T) {
	dir := t.TempDir()
	r := execRunner{exec.Command("pwd")}
	r.SetDir(dir)

	out, err := r.Output()
	if err != nil {
		t.Fatalf("Output: %v", err)
	}
	if strings.TrimSpace(string(out)) != dir {
		t.Errorf("Output = %q, want %q", out, dir)
	}
}

func TestExecRunner_SetEnvFullReplacement(t *testing.T) {
	// SetEnv is a full replacement: only the given keys are visible, inherited
	// ones (here HOME) are absent.
	r := execRunner{exec.Command("sh", "-c", "echo $CHEASEE_TEST; echo home=[$HOME]")}
	r.SetEnv([]string{"PATH=" + os.Getenv("PATH"), "CHEASEE_TEST=42"})

	out, err := r.Output()
	if err != nil {
		t.Fatalf("Output: %v", err)
	}
	if got := string(out); got != "42\nhome=[]\n" {
		t.Errorf("Output = %q, want CHEASEE_TEST visible and HOME absent", got)
	}
}

func TestExecRunner_SetStdoutSetStderrRun(t *testing.T) {
	// Writer + Run() style (docker compose build/up): independent capture per
	// stream, no capture methods involved.
	var outBuf, errBuf bytes.Buffer
	r := execRunner{exec.Command("sh", "-c", "echo out; echo err >&2")}
	r.SetStdout(&outBuf)
	r.SetStderr(&errBuf)

	if err := r.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if outBuf.String() != "out\n" {
		t.Errorf("stdout = %q, want %q", outBuf.String(), "out\n")
	}
	if errBuf.String() != "err\n" {
		t.Errorf("stderr = %q, want %q", errBuf.String(), "err\n")
	}
}

func TestExecRunner_SetStdinRun(t *testing.T) {
	// SetStdin (added for the execPIContainer port) feeds the child's stdin.
	var outBuf bytes.Buffer
	r := execRunner{exec.Command("sh", "-c", "read x; echo got:$x")}
	r.SetStdin(strings.NewReader("hi\n"))
	r.SetStdout(&outBuf)

	if err := r.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(outBuf.String(), "got:hi") {
		t.Errorf("stdout = %q, want it to echo the stdin line", outBuf.String())
	}
}

// ──────────────────────────────────────────────
// runCommandContext seam policy (WaitDelay + resolution)
// ──────────────────────────────────────────────
