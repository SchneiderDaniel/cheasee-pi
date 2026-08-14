package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// clean: container enumeration (compose project label)
// ──────────────────────────────────────────────

func TestCheaseePiContainers_parsesAndFilters(t *testing.T) {
	stubExecCommand(t, func(_ string, arg ...string) cmdIface {
		if len(arg) == 0 || arg[0] != "ps" {
			t.Fatalf("expected docker ps, got %v", arg)
		}
		if !slices.Contains(arg, "-a") {
			t.Fatalf("enumeration must list all containers (-a), got %v", arg)
		}
		return &mockCmd{outputFn: func() ([]byte, error) {
			// name \t state \t compose project label — two workspace containers
			// (main + codeflow sidecar), one legacy shared container, one
			// non-cheasee-pi project, one compose-less container.
			return []byte(
				"cheasee-pi-repoa\trunning\tcheasee-pi-repoa\n" +
					"codeflow-repoa\trunning\tcheasee-pi-repoa\n" +
					"cheasee-pi\texited\tcheasee-pi\n" +
					"other-app\trunning\tother-app\n" +
					"plain\trunning\t\n",
			), nil
		}}
	})

	containers, err := cheaseePiContainers()
	if err != nil {
		t.Fatalf("cheaseePiContainers: %v", err)
	}
	if len(containers) != 3 {
		t.Fatalf("expected 3 cheasee-pi containers (workspace main + codeflow + legacy), got %d: %v", len(containers), containers)
	}
	byName := map[string]bool{}
	for _, c := range containers {
		byName[c.name] = c.running
	}
	if !byName["cheasee-pi-repoa"] {
		t.Errorf("workspace main container must be enumerated (running), got %v", byName)
	}
	if !byName["codeflow-repoa"] {
		t.Errorf("codeflow sidecar must be enumerated (running), got %v", byName)
	}
	if byName["cheasee-pi"] {
		t.Errorf("legacy stopped container must be enumerated as not running, got %v", byName)
	}
	if _, ok := byName["other-app"]; ok {
		t.Errorf("non-cheasee-pi project container must be excluded, got %v", byName)
	}
	if _, ok := byName["plain"]; ok {
		t.Errorf("compose-less container must be excluded, got %v", byName)
	}
}

func TestCheaseePiContainers_dockerPsFails(t *testing.T) {
	stubExecCommand(t, func(_ string, _ ...string) cmdIface {
		return &mockCmd{outputFn: func() ([]byte, error) {
			return nil, fmt.Errorf("docker daemon not running")
		}}
	})

	if _, err := cheaseePiContainers(); err == nil {
		t.Fatal("expected error when docker ps fails, got nil")
	}
}

// ──────────────────────────────────────────────
// clean: full flow — orphan scan + rm + prune
// ──────────────────────────────────────────────

// stubCleanDocker stubs the execCommand seam for runCleanE: docker ps -a
// enumeration, per-container orphan-scan calls, docker rm, and the prune
// commands. Records every rm invocation.
func stubCleanDocker(t *testing.T, rmErr error) *[][]string {
	t.Helper()
	var rmCalls [][]string
	stubExecCommand(t, func(_ string, arg ...string) cmdIface {
		switch {
		case len(arg) > 0 && arg[0] == "ps" && slices.Contains(arg, "-a"):
			// Enumeration: one running workspace container + one stopped legacy.
			return &mockCmd{outputFn: func() ([]byte, error) {
				return []byte("cheasee-pi-repoa\trunning\tcheasee-pi-repoa\ncheasee-pi\texited\tcheasee-pi\n"), nil
			}}
		case len(arg) > 0 && arg[0] == "ps":
			// scanOrphans' running check — the workspace container is running.
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("cheasee-pi-repoa"), nil }}
		case len(arg) > 0 && arg[0] == "exec":
			// Orphan scan inside the running container kills one orphan.
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte("killing 42\n"), nil }}
		case len(arg) > 0 && arg[0] == "rm":
			rmCalls = append(rmCalls, append([]string{}, arg...))
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), rmErr }}
		case len(arg) > 0 && arg[0] == "images":
			// pruneDanglingImages: dangling images exist → prune runs.
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("sha256:abc\n"), nil }}
		default:
			return &mockCmd{} // docker image prune / buildx prune succeed
		}
	})
	return &rmCalls
}

func TestRunCleanE_removesAllCheaseePiContainers(t *testing.T) {
	rmCalls := stubCleanDocker(t, nil)

	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})

	if !strings.Contains(stderr, "✓ Killed 1 orphaned pi process(es)") {
		t.Errorf("orphan scan must report the killed process, got: %q", stderr)
	}
	if !strings.Contains(stderr, "✓ Removed 2 Cheasee-Pi container(s)") {
		t.Errorf("clean must report the removed containers, got: %q", stderr)
	}
	if !strings.Contains(stderr, "✓ Pruned dangling Docker images") {
		t.Errorf("clean must prune dangling images, got: %q", stderr)
	}
	if !strings.Contains(stderr, "✓ Pruned Docker build cache") {
		t.Errorf("clean must prune build cache, got: %q", stderr)
	}

	// Every enumerated container — running workspace one and stopped legacy —
	// is force-removed; the non-cheasee-pi project never reaches rm.
	if len(*rmCalls) != 2 {
		t.Fatalf("expected docker rm for 2 containers, got %d: %v", len(*rmCalls), *rmCalls)
	}
	for _, call := range *rmCalls {
		if len(call) != 3 || call[0] != "rm" || call[1] != "-f" {
			t.Errorf("rm invocation must be `docker rm -f <name>`, got %v", call)
		}
	}
	if !slices.ContainsFunc(*rmCalls, func(c []string) bool { return c[2] == "cheasee-pi-repoa" }) {
		t.Errorf("running workspace container must be removed, got %v", *rmCalls)
	}
	if !slices.ContainsFunc(*rmCalls, func(c []string) bool { return c[2] == "cheasee-pi" }) {
		t.Errorf("stopped legacy container must be removed, got %v", *rmCalls)
	}
}

func TestRunCleanE_orphanScanOnlyRunningContainers(t *testing.T) {
	stubExecCommand(t, func(_ string, arg ...string) cmdIface {
		switch {
		case len(arg) > 0 && arg[0] == "ps" && slices.Contains(arg, "-a"):
			return &mockCmd{outputFn: func() ([]byte, error) {
				return []byte("cheasee-pi-repoa\trunning\tcheasee-pi-repoa\ncheasee-pi-repob\texited\tcheasee-pi-repob\n"), nil
			}}
		case len(arg) > 0 && arg[0] == "ps":
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("cheasee-pi-repoa"), nil }}
		case len(arg) > 0 && arg[0] == "exec":
			if len(arg) > 1 && arg[1] == "cheasee-pi-repob" {
				t.Errorf("orphan scan must only run inside running containers (repob is stopped), got exec for %v", arg)
			}
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), nil }}
		case len(arg) > 0 && arg[0] == "rm":
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), nil }}
		default:
			return &mockCmd{}
		}
	})

	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})
	if !strings.Contains(stderr, "✓ Removed 2 Cheasee-Pi container(s)") {
		t.Errorf("both containers must be removed, got: %q", stderr)
	}
}

func TestRunCleanE_toleratesVanishedContainer(t *testing.T) {
	// A container removed between enumeration and rm reports "No such
	// container" — clean must not fail on it.
	stubExecCommand(t, func(_ string, arg ...string) cmdIface {
		switch {
		case len(arg) > 0 && arg[0] == "ps" && slices.Contains(arg, "-a"):
			return &mockCmd{outputFn: func() ([]byte, error) {
				return []byte("cheasee-pi-repoa\trunning\tcheasee-pi-repoa\n"), nil
			}}
		case len(arg) > 0 && arg[0] == "ps":
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("cheasee-pi-repoa"), nil }}
		case len(arg) > 0 && arg[0] == "exec":
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), nil }}
		case len(arg) > 0 && arg[0] == "rm":
			return &mockCmd{combinedFn: func() ([]byte, error) {
				return []byte("Error: No such container: cheasee-pi-repoa"), fmt.Errorf("exit status 1")
			}}
		default:
			return &mockCmd{}
		}
	})

	if err := runCleanE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("clean must tolerate a vanished container, got %v", err)
	}
}

func TestRunCleanE_rmFailureFails(t *testing.T) {
	stubExecCommand(t, func(_ string, arg ...string) cmdIface {
		switch {
		case len(arg) > 0 && arg[0] == "ps" && slices.Contains(arg, "-a"):
			return &mockCmd{outputFn: func() ([]byte, error) {
				return []byte("cheasee-pi-repoa\trunning\tcheasee-pi-repoa\n"), nil
			}}
		case len(arg) > 0 && arg[0] == "ps":
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("cheasee-pi-repoa"), nil }}
		case len(arg) > 0 && arg[0] == "exec":
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), nil }}
		case len(arg) > 0 && arg[0] == "rm":
			return &mockCmd{combinedFn: func() ([]byte, error) {
				return []byte("permission denied"), fmt.Errorf("exit status 1")
			}}
		default:
			return &mockCmd{}
		}
	})

	err := runCleanE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "docker rm") {
		t.Fatalf("expected rm failure to fail clean, got %v", err)
	}
}

func TestRunCleanE_noContainers(t *testing.T) {
	stubExecCommand(t, func(_ string, arg ...string) cmdIface {
		if len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		return &mockCmd{}
	})

	stderr := testutil.CaptureStderr(t, func() {
		if err := runCleanE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runCleanE: %v", err)
		}
	})
	if !strings.Contains(stderr, "ℹ No Cheasee-Pi containers found") {
		t.Errorf("empty enumeration must announce no containers, got: %q", stderr)
	}
}

// sanity: runCleanE takes a context for the orphan scan without panicking.
func TestRunCleanE_contextPassed(t *testing.T) {
	stubExecCommand(t, func(_ string, arg ...string) cmdIface {
		return &mockCmd{}
	})
	ctx := context.Background()
	cmd := &cobra.Command{}
	cmd.SetContext(ctx)
	if err := runCleanE(cmd, nil); err != nil {
		t.Fatalf("runCleanE: %v", err)
	}
}
