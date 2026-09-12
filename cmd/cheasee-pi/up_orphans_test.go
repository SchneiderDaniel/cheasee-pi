package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
)

// Orphan session scan/kill coverage: the orphanScanBash script text,
// scanOrphans orchestration and killSessionByMarker. Moved verbatim
// from up_test.go.
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// orphanScanBash tests — Phase 2
// ──────────────────────────────────────────────

func TestOrphanScanBash_filtersByPPid(t *testing.T) {
	if !strings.Contains(orphanScanBash, `"1"`) {
		t.Error("orphanScanBash missing PPid=1 filter")
	}
	if !strings.Contains(orphanScanBash, `$ppid`) {
		t.Error("orphanScanBash missing ppid variable")
	}
	if !strings.Contains(orphanScanBash, `awk '{print $4}'`) {
		t.Error("orphanScanBash should use awk to extract PPID from /proc/*/stat")
	}
}

func TestOrphanScanBash_anchoredCmdline(t *testing.T) {
	if strings.Contains(orphanScanBash, `*pi*`) {
		t.Error("orphanScanBash uses dangerous *pi* substring match")
	}
	if !strings.Contains(orphanScanBash, `/usr/bin/pi`) && !strings.Contains(orphanScanBash, `"pi `) {
		t.Error("orphanScanBash missing anchored /usr/bin/pi or pi pattern")
	}
}

func TestOrphanScanBash_iteratesProcStat(t *testing.T) {
	if !strings.Contains(orphanScanBash, "/proc/[0-9]*/stat") {
		t.Error("orphanScanBash should iterate /proc/[0-9]*/stat")
	}
}

func TestOrphanScanBash_swallowsESRCH(t *testing.T) {
	if !strings.Contains(orphanScanBash, "2>/dev/null") {
		t.Error("orphanScanBash should swallow errors on kill (ESRCH)")
	}
}

func TestOrphanScanBash_echoesKilledPIDs(t *testing.T) {
	if !strings.Contains(orphanScanBash, "echo ") {
		t.Error("orphanScanBash should echo killed PIDs for user feedback")
	}
}

func TestOrphanScanBash_ageReaperGatedByEnv(t *testing.T) {
	if !strings.Contains(orphanScanBash, "CHEASEE_MAX_AGE_MIN") {
		t.Error("orphanScanBash should gate the age reaper on CHEASEE_MAX_AGE_MIN")
	}
	if !strings.Contains(orphanScanBash, "/proc/uptime") {
		t.Error("orphanScanBash should compute session age from /proc/uptime")
	}
	if !strings.Contains(orphanScanBash, "awk '{print $22}'") {
		t.Error("orphanScanBash should read start time (stat field 22) for age")
	}
	if !strings.Contains(orphanScanBash, "6000") {
		t.Error("orphanScanBash should convert ticks to minutes (6000 ticks/min)")
	}
}

// ──────────────────────────────────────────────
// scanOrphans tests — Phase 3
// ──────────────────────────────────────────────

func TestScanOrphans_containerNotRunning(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{
			outputFn: func() ([]byte, error) {
				return []byte(""), nil
			},
		}
	})

	killed, err := scanOrphans(context.Background(), "cheasee-pi", 0, false)
	if err != nil {
		t.Fatalf("scanOrphans returned error for not-running container: %v", err)
	}
	if len(killed) != 0 {
		t.Errorf("expected 0 killed for not-running container, got %d", len(killed))
	}
}

func TestScanOrphans_noOrphans(t *testing.T) {
	step := 0
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		step++
		if step == 1 {
			return &mockCmd{
				outputFn: func() ([]byte, error) {
					return []byte("cheasee-pi"), nil
				},
			}
		}
		return &mockCmd{
			combinedFn: func() ([]byte, error) {
				return []byte(""), nil
			},
		}
	})

	killed, err := scanOrphans(context.Background(), "cheasee-pi", 0, false)
	if err != nil {
		t.Fatalf("scanOrphans returned error: %v", err)
	}
	if len(killed) != 0 {
		t.Errorf("expected 0 killed, got %d", len(killed))
	}
}

func TestScanOrphans_countsKilled(t *testing.T) {
	step := 0
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		step++
		if step == 1 {
			return &mockCmd{
				outputFn: func() ([]byte, error) {
					return []byte("cheasee-pi"), nil
				},
			}
		}
		return &mockCmd{
			combinedFn: func() ([]byte, error) {
				return []byte("killing 42\nkilling 99\n"), nil
			},
		}
	})

	killed, err := scanOrphans(context.Background(), "cheasee-pi", 0, false)
	if err != nil {
		t.Fatalf("scanOrphans returned error: %v", err)
	}
	if len(killed) != 2 {
		t.Errorf("expected 2 killed, got %d", len(killed))
	}
}

func TestScanOrphans_skipsWhenBashMissing(t *testing.T) {
	// Sidecar containers (codeflow/code-server style images) ship without
	// bash: docker exec fails with exit 127. The scan must not abort the
	// whole clean over a container that never hosts pi — skip gracefully.
	step := 0
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		step++
		if step == 1 {
			return &mockCmd{
				outputFn: func() ([]byte, error) {
					return []byte("cheasee-pi"), nil
				},
			}
		}
		return &mockCmd{
			combinedFn: func() ([]byte, error) {
				return []byte("exec: \"bash\": executable file not found in $PATH"), fmt.Errorf("exit status 127")
			},
		}
	})

	killed, err := scanOrphans(context.Background(), "cheasee-pi", 0, false)
	if err != nil {
		t.Fatalf("missing bash must skip, not abort: %v", err)
	}
	if len(killed) != 0 {
		t.Errorf("expected 0 killed for unscannable container, got %d", len(killed))
	}
}

func TestScanOrphans_constructsDockerExecCommand(t *testing.T) {
	var capturedName string
	var capturedArgs []string
	step := 0
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		step++
		if step == 1 {
			return &mockCmd{
				outputFn: func() ([]byte, error) {
					return []byte("cheasee-pi"), nil
				},
			}
		}
		capturedName = name
		capturedArgs = arg
		return &mockCmd{
			combinedFn: func() ([]byte, error) {
				return []byte(""), nil
			},
		}
	})

	scanOrphans(context.Background(), "cheasee-pi", 0, false)

	if capturedName != "docker" {
		t.Errorf("expected docker, got %q", capturedName)
	}
	if len(capturedArgs) < 8 {
		t.Fatalf("too few args: %v", capturedArgs)
	}
	if capturedArgs[0] != "exec" {
		t.Errorf("expected exec, got %q", capturedArgs[0])
	}
	if capturedArgs[1] != "-e" {
		t.Errorf("expected -e, got %q", capturedArgs[1])
	}
	if capturedArgs[2] != "CHEASEE_MAX_AGE_MIN=0" {
		t.Errorf("expected age-reaper env, got %q", capturedArgs[2])
	}
	if capturedArgs[3] != "-e" {
		t.Errorf("expected second -e, got %q", capturedArgs[3])
	}
	if capturedArgs[4] != "CHEASEE_DRY_RUN=0" {
		t.Errorf("expected dry-run env, got %q", capturedArgs[4])
	}
	if capturedArgs[5] != "cheasee-pi" {
		t.Errorf("expected container name, got %q", capturedArgs[5])
	}
	if capturedArgs[6] != "bash" || capturedArgs[7] != "-c" {
		t.Errorf("expected bash -c, got %v", capturedArgs[6:8])
	}
	if capturedArgs[8] != orphanScanBash {
		t.Errorf("expected orphanScanBash as script argument")
	}
}

func TestScanOrphans_forwardsMaxAgeEnv(t *testing.T) {
	step := 0
	var capturedArgs []string
	stubRunCommandContext(t, func(_ context.Context, _ string, arg ...string) runner {
		step++
		if step == 1 {
			return &mockCmd{
				outputFn: func() ([]byte, error) {
					return []byte("cheasee-pi"), nil
				},
			}
		}
		capturedArgs = arg
		return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), nil }}
	})

	scanOrphans(context.Background(), "cheasee-pi", 45, false)

	if !slices.Contains(capturedArgs, "CHEASEE_MAX_AGE_MIN=45") {
		t.Errorf("expected CHEASEE_MAX_AGE_MIN=45 in args, got %v", capturedArgs)
	}
	if !slices.Contains(capturedArgs, "CHEASEE_DRY_RUN=0") {
		t.Errorf("expected CHEASEE_DRY_RUN=0 in args, got %v", capturedArgs)
	}
}

func TestScanOrphans_dryRunEnvFlag(t *testing.T) {
	step := 0
	var capturedArgs []string
	stubRunCommandContext(t, func(_ context.Context, _ string, arg ...string) runner {
		step++
		if step == 1 {
			return &mockCmd{
				outputFn: func() ([]byte, error) {
					return []byte("cheasee-pi"), nil
				},
			}
		}
		capturedArgs = arg
		return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), nil }}
	})

	scanOrphans(context.Background(), "cheasee-pi", 30, true)

	if !slices.Contains(capturedArgs, "CHEASEE_DRY_RUN=1") {
		t.Errorf("expected CHEASEE_DRY_RUN=1 in args, got %v", capturedArgs)
	}
}

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

func TestScanOrphans_dockerPsFails(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{
			outputFn: func() ([]byte, error) {
				return nil, fmt.Errorf("docker daemon not running")
			},
		}
	})

	_, err := scanOrphans(context.Background(), "cheasee-pi", 0, false)
	if err == nil {
		t.Fatal("expected error when docker ps fails, got nil")
	}
}
