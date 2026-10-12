package main

import (
	"context"
	"fmt"
	"slices"
	"testing"
)

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
