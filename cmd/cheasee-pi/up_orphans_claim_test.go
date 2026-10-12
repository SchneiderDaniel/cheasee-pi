package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKillSessionByMarker_killsMatchingSession(t *testing.T) {
	var capturedArgs []string
	stubRunCommandContext(t, func(_ context.Context, _ string, arg ...string) runner {
		capturedArgs = arg
		return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), nil }}
	})

	if err := killSessionByMarker(context.Background(), "cheasee-pi", "deadbeef"); err != nil {
		t.Fatalf("killSessionByMarker returned error: %v", err)
	}

	if capturedArgs[0] != "exec" || capturedArgs[1] != "cheasee-pi" || capturedArgs[2] != "bash" || capturedArgs[3] != "-c" {
		t.Fatalf("unexpected docker exec args: %v", capturedArgs)
	}
	script := capturedArgs[4]
	if !strings.Contains(script, "CHEASEE_SESSION_ID=deadbeef") {
		t.Errorf("script missing session marker, got: %s", script)
	}
	if !strings.Contains(script, "kill ") {
		t.Errorf("script missing kill, got: %s", script)
	}
}

func TestKillSessionByMarker_emptyIDIsNoop(t *testing.T) {
	calls := 0
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		calls++
		t.Fatal("no docker exec expected for empty session id")
		return nil
	})
	if err := killSessionByMarker(context.Background(), "cheasee-pi", ""); err != nil {
		t.Fatalf("empty id returned error: %v", err)
	}
	if calls != 0 {
		t.Errorf("empty id must not touch the seam, got %d call(s)", calls)
	}
}

// TestKillSessionByMarker_purgesClaim guards the cross-container join: the
// reaper must drop the shared-mount claim for the exact session it killed, or
// a stale claim blocks every future resume.
func TestKillSessionByMarker_purgesClaim(t *testing.T) {
	var capturedArgs []string
	stubRunCommandContext(t, func(_ context.Context, _ string, arg ...string) runner {
		capturedArgs = arg
		return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), nil }}
	})

	if err := killSessionByMarker(context.Background(), "cheasee-pi", "deadbeef"); err != nil {
		t.Fatalf("killSessionByMarker: %v", err)
	}
	script := capturedArgs[4]
	claim := inUseClaimDir + "/deadbeef"
	if !strings.Contains(script, "rm -f "+claim) {
		t.Errorf("reaper must remove the claim %s, got: %s", claim, script)
	}
}

// TestInUseClaim_writeAndRemove pins the claim lifecycle the ui guard reads.
func TestInUseClaim_writeAndRemove(t *testing.T) {
	sessionDir := filepath.Join(t.TempDir(), ".pi", "sessions")

	if err := writeInUseClaim(sessionDir, "deadbeef", "cheasee-pi-repoA"); err != nil {
		t.Fatalf("writeInUseClaim: %v", err)
	}
	claim := filepath.Join(sessionDir, ".cheasee-inuse", "deadbeef")
	body, err := os.ReadFile(claim)
	if err != nil {
		t.Fatalf("claim file missing: %v", err)
	}
	for _, want := range []string{"cheasee-pi-repoA", "startedAt"} {
		if !strings.Contains(string(body), want) {
			t.Errorf("claim body must carry %q, got %s", want, body)
		}
	}

	if err := removeInUseClaim(sessionDir, "deadbeef"); err != nil {
		t.Fatalf("removeInUseClaim: %v", err)
	}
	if _, err := os.Stat(claim); !os.IsNotExist(err) {
		t.Errorf("claim must be gone, stat err = %v", err)
	}
	// Re-removing a missing claim is not an error.
	if err := removeInUseClaim(sessionDir, "deadbeef"); err != nil {
		t.Errorf("missing claim removal must be a no-op, got %v", err)
	}

	// The whole directory purge that clean/down use.
	if err := writeInUseClaim(sessionDir, "cafef00d", "cheasee-pi-repoA"); err != nil {
		t.Fatalf("writeInUseClaim: %v", err)
	}
	if err := purgeInUseClaims(sessionDir); err != nil {
		t.Fatalf("purgeInUseClaims: %v", err)
	}
	if _, err := os.Stat(filepath.Join(sessionDir, ".cheasee-inuse")); !os.IsNotExist(err) {
		t.Errorf("claim dir must be removed, stat err = %v", err)
	}
}

// TestInUseClaim_crossContainerPathPin (AC5) pins the two literals that join
// the Go writer and the Rust reader on the shared workspace mount: the claim
// is <SESSION_DIR>/.cheasee-inuse. A drift on either side silently disables
// the UI's cross-container in-use guard, so both languages are read here.
func TestInUseClaim_crossContainerPathPin(t *testing.T) {
	const sessionDir = "/workspaces/main/.pi/sessions"
	if inUseClaimDir != sessionDir+"/.cheasee-inuse" {
		t.Errorf("inUseClaimDir = %q, want %q", inUseClaimDir, sessionDir+"/.cheasee-inuse")
	}

	rustDir := filepath.Join("embedded", "docker", "ui", "src")
	piProcess, err := os.ReadFile(filepath.Join(rustDir, "pi_process.rs"))
	if err != nil {
		t.Fatalf("read pi_process.rs: %v", err)
	}
	if !strings.Contains(string(piProcess), `SESSION_DIR: &str = "`+sessionDir+`"`) {
		t.Errorf("Rust SESSION_DIR must equal %q (the Go/Rust join key)", sessionDir)
	}
	mainRs, err := os.ReadFile(filepath.Join(rustDir, "main.rs"))
	if err != nil {
		t.Fatalf("read main.rs: %v", err)
	}
	if !strings.Contains(string(mainRs), `".cheasee-inuse"`) {
		t.Error(`Rust must join the ".cheasee-inuse" claim dir off SESSION_DIR`)
	}
}
