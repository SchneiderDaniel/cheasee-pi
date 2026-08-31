package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
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

func TestRunCommandContext_SetsWaitDelay(t *testing.T) {
	// Cancellation-wedge policy (bounded post-exit drain) lives in the seam,
	// not at call sites.
	r := runCommandContext(context.Background(), "true")
	er, ok := r.(execRunner)
	if !ok {
		t.Fatalf("runCommandContext returned %T, want execRunner", r)
	}
	if er.Cmd.WaitDelay != execWaitDelay {
		t.Errorf("WaitDelay = %v, want %v", er.Cmd.WaitDelay, execWaitDelay)
	}
	if execWaitDelay <= 0 {
		t.Errorf("execWaitDelay must be positive, got %v", execWaitDelay)
	}
}

func TestRunCommandContext_cancelKillsDirectChild(t *testing.T) {
	// A canceled ctx kills the direct child; WaitDelay keeps the pipe drain
	// (grandchild still holding it) from wedging CombinedOutput forever.
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, err := runCommandContext(ctx, "sh", "-c", "sleep 30").CombinedOutput()
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("CombinedOutput must error on ctx cancel")
	}
	if elapsed > 15*time.Second {
		t.Errorf("cancel must not wait for the 30s grandchild: took %v", elapsed)
	}
}

func TestRunCommandContext_waitDelayBoundsGrandchildPipeWedge(t *testing.T) {
	// Child exits quickly but a grandchild holds the pipe write-end open:
	// WaitDelay must error the capture instead of blocking until the
	// grandchild exits (research-verified CommandContext hazard).
	start := time.Now()
	_, err := runCommandContext(context.Background(), "sh", "-c", "(sleep 30; echo late) & echo done").CombinedOutput()
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("pipe wedge must produce an error via WaitDelay")
	}
	if elapsed > 10*time.Second {
		t.Errorf("WaitDelay must bound the wedge: took %v", elapsed)
	}
}

func TestRunCommandContext_missingBinarySurfaces(t *testing.T) {
	// Go 1.19+ path security: a bare name that resolves nowhere surfaces as
	// *exec.Error naming the binary — uniform behind the seam (lookPath
	// pre-check stays the docker-specific friendly layer).
	const bin = "definitely-not-a-real-bin-xyz"
	_, err := runCommandContext(context.Background(), bin).Output()
	if err == nil {
		t.Fatal("missing binary must error")
	}
	var ee *exec.Error
	if !errors.As(err, &ee) {
		t.Fatalf("error = %T (%v), want *exec.Error", err, err)
	}
	if ee.Name != bin {
		t.Errorf("exec.Error.Name = %q, want %q", ee.Name, bin)
	}
}

// ──────────────────────────────────────────────
// Writer/capture split invariant (empirically verified stdlib)
// ──────────────────────────────────────────────

func TestExecRunner_setStdoutThenCombinedOutputRejected(t *testing.T) {
	r := execRunner{exec.Command("true")}
	r.SetStdout(&bytes.Buffer{})

	_, err := r.CombinedOutput()
	if err == nil || !strings.Contains(err.Error(), "exec: Stdout already set") {
		t.Fatalf("SetStdout + CombinedOutput = %v, want Stdout-already-set", err)
	}
}

func TestExecRunner_setStdoutThenOutputRejected(t *testing.T) {
	r := execRunner{exec.Command("true")}
	r.SetStdout(&bytes.Buffer{})

	_, err := r.Output()
	if err == nil || !strings.Contains(err.Error(), "exec: Stdout already set") {
		t.Fatalf("SetStdout + Output = %v, want Stdout-already-set", err)
	}
}

func TestExecRunner_setStderrThenOutputAllowed(t *testing.T) {
	// stdlib asymmetry: Output only checks Stdout, so a pre-set Stderr is
	// legal (and reset) — capture sites stay split from writer sites.
	r := execRunner{exec.Command("echo", "hi")}
	r.SetStderr(&bytes.Buffer{})

	out, err := r.Output()
	if err != nil {
		t.Fatalf("SetStderr + Output = %v, want nil", err)
	}
	if string(out) != "hi\n" {
		t.Errorf("Output = %q, want %q", out, "hi\n")
	}
}

func TestExecRunner_setStdinThenOutputAllowed(t *testing.T) {
	r := execRunner{exec.Command("cat")}
	r.SetStdin(strings.NewReader("hi\n"))

	out, err := r.Output()
	if err != nil {
		t.Fatalf("SetStdin + Output = %v, want nil", err)
	}
	if string(out) != "hi\n" {
		t.Errorf("Output = %q, want %q", out, "hi\n")
	}
}
