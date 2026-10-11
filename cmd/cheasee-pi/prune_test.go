package main

import (
	"context"
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
	"slices"
	"strings"
	"testing"
)

// pruneTestStub stubs the docker seam for prune-images tests and returns the
// recorded docker argv vectors. containers feeds every `docker ps -a`
// listing (the managed-container gate: non-empty → abort), imageLS is the
// `docker image ls` output, and rmFailOn names the ref whose `image rm -f`
// fails (empty = never).
func pruneTestStub(t *testing.T, containers []string, imageLS, rmFailOn string) *[][]string {
	t.Helper()
	var calls [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		calls = append(calls, append([]string(nil), arg...))
		if len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(strings.Join(containers, "\n")), nil }}
		}
		if len(arg) > 1 && arg[0] == "image" && arg[1] == "ls" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(imageLS), nil }}
		}
		if len(arg) > 1 && arg[0] == "image" && arg[1] == "rm" && rmFailOn != "" && slices.Contains(arg, rmFailOn) {
			return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("conflict") }}
		}
		return &mockCmd{} // image rm, image prune, buildx prune
	})
	return &calls
}

// assertNoMutations fails the test if the recorded docker calls contain any
// image rm or any prune invocation.
func assertNoMutations(t *testing.T, calls *[][]string) {
	t.Helper()
	for _, arg := range *calls {
		if len(arg) > 1 && arg[0] == "image" && arg[1] == "rm" {
			t.Errorf("no image rm expected, got %v", arg)
		}
		if slices.Contains(arg, "prune") {
			t.Errorf("no prune expected, got %v", arg)
		}
	}
}

// resetPruneState pins the prune-images package vars for the duration of a
// test and restores the confirm seam to the production prompt.
func resetPruneState(t *testing.T) {
	t.Helper()
	pruneImagesDryRun = false
	pruneImagesYes = false
	saved := pruneImagesConfirmFn
	pruneImagesConfirmFn = promptConfirm
	t.Cleanup(func() {
		pruneImagesDryRun = false
		pruneImagesYes = false
		pruneImagesConfirmFn = saved
	})
}

// captureRunCobra executes prune-images through a fresh root command and
// returns the CLI's os.Stderr progress plus cobra's stdout/error streams, and
// the execution error. A fresh root per call keeps the global pruneImagesCmd
// re-parented safely (RunCobra on rootCmd would resolve its output through
// the stale parent after a journey run). The fresh root defines the
// maintenance group because pruneImagesCmd carries GroupID groupIDMaintenance
// and cobra's ExecuteC validates that the parent defines every child group
// (undefined ID → panic).
func captureRunCobra(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var out, errOut strings.Builder
	var runErr error
	stderr := testutil.CaptureStderr(t, func() {
		cmd := &cobra.Command{Use: "cheasee-pi"}
		cmd.AddGroup(&cobra.Group{ID: groupIDMaintenance, Title: "Maintenance"})
		cmd.AddCommand(pruneImagesCmd)
		cmd.SetArgs(args)
		cmd.SetOut(&out)
		cmd.SetErr(&errOut)
		runErr = cmd.Execute()
	})
	return stderr + out.String() + errOut.String(), runErr
}

// ──────────────────────────────────────────────
// Phase 1: scope predicate + enumeration/removal adapter
// ──────────────────────────────────────────────

func TestPruneDanglingImages_UngatedRunsUnconditionally(t *testing.T) {
	// Ungated (prune-images) must run the prune even with a raced/empty list.
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		return &mockCmd{}
	})
	if err := pruneDanglingImages(context.Background(), false); err != nil {
		t.Fatalf("ungated prune: %v", err)
	}
	if len(recorded) != 1 || !slices.Equal(recorded[0], []string{"image", "prune", "-f"}) {
		t.Errorf("ungated prune must invoke docker image prune -f directly, got %v", recorded)
	}
}

func TestPruneDanglingImages_UngatedFailureSurfaces(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("cannot prune") }}
	})
	err := pruneDanglingImages(context.Background(), false)
	if err == nil || !strings.Contains(err.Error(), "docker image prune") || !strings.Contains(err.Error(), "cannot prune") {
		t.Fatalf("ungated prune failure must surface wrapped, got %v", err)
	}
}

func TestRunPruneImagesE_imagePruneFailureSurfaces(t *testing.T) {
	// image rm succeeds, then `docker image prune` fails: the error must be
	// propagated (tagged images may be gone, but the disk pressure they caused
	// is not) and the buildx prune step must not run.
	resetPruneState(t)
	pruneImagesYes = true
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		if len(arg) > 1 && arg[0] == "image" && arg[1] == "ls" {
			return &mockCmd{outputFn: func() ([]byte, error) {
				return []byte("cheasee-pi-repoA-cheasee-pi:latest|3.4GB\n"), nil
			}}
		}
		if len(arg) > 1 && arg[0] == "image" && arg[1] == "prune" {
			return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("cannot prune") }}
		}
		return &mockCmd{}
	})
	err := runPruneImagesE(pruneImagesCmd, nil)
	if err == nil || !strings.Contains(err.Error(), "prune-images:") || !strings.Contains(err.Error(), "docker image prune") {
		t.Fatalf("image prune failure must surface wrapped, got %v", err)
	}
	for _, arg := range recorded {
		if len(arg) > 0 && arg[0] == "buildx" {
			t.Errorf("failed image prune must stop before buildx prune, got %v", arg)
		}
	}
}

func TestRunPruneImagesE_buildxPruneFailureSurfaces(t *testing.T) {
	// image rm and image prune succeed, then `docker buildx prune -a -f`
	// fails: the error must be propagated, not swallowed into success.
	resetPruneState(t)
	pruneImagesYes = true
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		if len(arg) > 1 && arg[0] == "image" && arg[1] == "ls" {
			return &mockCmd{outputFn: func() ([]byte, error) {
				return []byte("cheasee-pi-repoA-cheasee-pi:latest|3.4GB\n"), nil
			}}
		}
		if len(arg) > 0 && arg[0] == "buildx" {
			return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("builder busy") }}
		}
		return &mockCmd{}
	})
	err := runPruneImagesE(pruneImagesCmd, nil)
	if err == nil || !strings.Contains(err.Error(), "prune-images:") || !strings.Contains(err.Error(), "docker buildx prune") {
		t.Fatalf("buildx prune failure must surface wrapped, got %v", err)
	}
}

func TestRunPruneImagesE_pruneOrderingOnSuccess(t *testing.T) {
	// Full success path: image rm ×2, then image prune, then buildx prune -a.
	resetPruneState(t)
	pruneImagesYes = true
	calls := pruneTestStub(t, nil, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\ncheasee-pi-repoA-codeflow:latest|1.2GB\n", "")
	testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	var seq []string
	for _, arg := range *calls {
		switch {
		case len(arg) > 1 && arg[0] == "image" && arg[1] == "rm":
			seq = append(seq, "rm")
		case len(arg) > 1 && arg[0] == "image" && arg[1] == "prune":
			seq = append(seq, "image-prune")
		case len(arg) > 0 && arg[0] == "buildx":
			seq = append(seq, "buildx-prune")
		}
	}
	want := []string{"rm", "rm", "image-prune", "buildx-prune"}
	if !slices.Equal(seq, want) {
		t.Errorf("prune sequence = %v, want %v", seq, want)
	}
}

func TestPruneImages_Journey(t *testing.T) {
	resetPruneState(t)
	const imageLS = "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\ncheasee-pi-repoA-codeflow:latest|1.2GB\ncheasee-pi-repoA-ui:latest|0.9GB\n"

	// 1. A managed container exists → the user sees the clean-first
	//    instruction and nothing is removed.
	blocked := pruneTestStub(t, []string{"cheasee-pi-repoA"}, imageLS, "")
	_, err := captureRunCobra(t, "prune-images")
	if err == nil || !strings.Contains(err.Error(), "cheasee-pi clean") {
		t.Fatalf("journey: blocked state must point at `cheasee-pi clean`, got %v", err)
	}
	assertNoMutations(t, blocked)

	// 2. With no containers, --dry-run previews the reclaimable refs.
	resetPruneState(t)
	preview := pruneTestStub(t, nil, imageLS, "")
	stderr, err := captureRunCobra(t, "prune-images", "--dry-run")
	if err != nil {
		t.Fatalf("journey: dry-run: %v", err)
	}
	for _, want := range []string{"cheasee-pi-repoA-cheasee-pi:latest", "cheasee-pi-repoA-codeflow:latest", "cheasee-pi-repoA-ui:latest", "Dry-run"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("journey: dry-run must report %q, got %q", want, stderr)
		}
	}
	assertNoMutations(t, preview)

	// 3. --yes reports per-image removals and runs both prune steps.
	resetPruneState(t)
	real := pruneTestStub(t, nil, imageLS, "")
	stderr, err = captureRunCobra(t, "prune-images", "--yes")
	if err != nil {
		t.Fatalf("journey: --yes: %v", err)
	}
	for _, want := range []string{
		"Removed image cheasee-pi-repoA-cheasee-pi:latest",
		"Removed image cheasee-pi-repoA-codeflow:latest",
		"Removed image cheasee-pi-repoA-ui:latest",
		"Pruned dangling Docker images",
		"Pruned Docker build cache (all projects)",
	} {
		if !strings.Contains(stderr, want) {
			t.Errorf("journey: --yes must report %q, got %q", want, stderr)
		}
	}
	if len(*real) == 0 {
		t.Error("journey: --yes must issue docker commands")
	}
}

// ──────────────────────────────────────────────
// Registration
// ──────────────────────────────────────────────

func TestPruneImagesCmd_RegisteredOnRoot(t *testing.T) {
	cmd, _, err := rootCmd.Find([]string{"prune-images"})
	if err != nil {
		t.Fatalf("prune-images must be registered on rootCmd: %v", err)
	}
	if cmd.RunE == nil {
		t.Error("prune-images must use RunE")
	}
	if !cmd.DisableAutoGenTag {
		t.Error("prune-images must disable auto-generated help tags")
	}
	for _, flag := range []string{"dry-run", "yes"} {
		if cmd.Flags().Lookup(flag) == nil {
			t.Errorf("prune-images must expose --%s", flag)
		}
	}
}

func TestPruneImagesCmd_HelpMentionsFlags(t *testing.T) {
	out, err := captureRunCobra(t, "prune-images", "--help")
	if err != nil {
		t.Fatalf("prune-images --help: %v", err)
	}
	for _, want := range []string{"--dry-run", "--yes"} {
		if !strings.Contains(out, want) {
			t.Errorf("prune-images --help must mention %s, got %q", want, out)
		}
	}
}
