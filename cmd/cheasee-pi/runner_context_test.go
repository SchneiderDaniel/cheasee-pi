package main

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"
)

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
