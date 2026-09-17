package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
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

func TestIsCheaseePiImageRef(t *testing.T) {
	for _, ref := range []string{
		"cheasee-pi-repoA-cheasee-pi:latest", // per-repo main service image
		"cheasee-pi-repoA-codeflow:latest",   // per-repo codeflow sidecar image
		"cheasee-pi-cheasee-pi:latest",       // legacy pre-derivation image
		"cheasee-pi-cheasee-pi:v2",           // any tag, not just latest
	} {
		if !isCheaseePiImageRef(ref) {
			t.Errorf("isCheaseePiImageRef(%q) = false, want true", ref)
		}
	}
	for _, ref := range []string{
		"codeflow-foo:latest",      // codeflow-* deliberately dropped (no CLI image uses it)
		"my-cheasee-pi-app:latest", // mid-string, not a prefix
		"cheasee-piffy:latest",     // no hyphen boundary after the prefix
		"<none>:<none>",            // dangling image — no references, never enumerated
		"cheasee-pi:latest",        // compose always appends -<service>; the prefix requires the trailing hyphen
	} {
		if isCheaseePiImageRef(ref) {
			t.Errorf("isCheaseePiImageRef(%q) = true, want false", ref)
		}
	}
}

func TestImageNamePrefix_IsSingleSourceOfTruth(t *testing.T) {
	// Pins the scope literal so the daemon reference= filter and the Go
	// predicate are both covered by one assertion.
	if imageNamePrefix != "cheasee-pi-" {
		t.Errorf("imageNamePrefix = %q, want %q", imageNamePrefix, "cheasee-pi-")
	}
}

func TestListCheaseePiImages_FilterAndPostFilter(t *testing.T) {
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		return &mockCmd{outputFn: func() ([]byte, error) {
			return []byte("foreign-app:latest\ncheasee-pi-repoA-cheasee-pi:latest|3.4GB\n<none>:<none>\ncheasee-pi-repoA-codeflow:latest|1.2GB\n\n"), nil
		}}
	})

	images, err := listCheaseePiImages(context.Background())
	if err != nil {
		t.Fatalf("listCheaseePiImages: %v", err)
	}

	// The daemon filter must stay in lockstep with the Go predicate.
	wantFilter := []string{"image", "ls", "--filter", "reference=" + imageNamePrefix + "*", "--format", "{{.Repository}}:{{.Tag}}|{{.Size}}"}
	if len(recorded) != 1 || !slices.Equal(recorded[0], wantFilter) {
		t.Errorf("docker invocation = %v, want %v", recorded, wantFilter)
	}

	if len(images) != 2 {
		t.Fatalf("expected 2 cheasee-pi images, got %d: %+v", len(images), images)
	}
	if images[0].Ref != "cheasee-pi-repoA-cheasee-pi:latest" || images[0].Size != "3.4GB" {
		t.Errorf("first entry = %+v, want cheasee-pi-repoA-cheasee-pi:latest/3.4GB", images[0])
	}
	if images[1].Ref != "cheasee-pi-repoA-codeflow:latest" || images[1].Size != "1.2GB" {
		t.Errorf("second entry = %+v, want cheasee-pi-repoA-codeflow:latest/1.2GB", images[1])
	}
}

func TestListCheaseePiImages_EmptyOutput(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
	})
	images, err := listCheaseePiImages(context.Background())
	if err != nil {
		t.Fatalf("listCheaseePiImages: %v", err)
	}
	if len(images) != 0 {
		t.Errorf("empty daemon output must yield an empty slice, got %+v", images)
	}
}

func TestListCheaseePiImages_DockerFailureSurfaces(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
	})
	images, err := listCheaseePiImages(context.Background())
	if err == nil || !strings.Contains(err.Error(), "docker image ls") || !strings.Contains(err.Error(), "daemon down") {
		t.Fatalf("docker failure must surface wrapped, got err=%v images=%+v", err, images)
	}
}

func TestListCheaseePiImages_SameIDTwoTagsKeptSeparate(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) {
			return []byte("cheasee-pi-repoA-cheasee-pi:latest|3.4GB\ncheasee-pi-repoA-cheasee-pi:v2|3.4GB\n"), nil
		}}
	})
	images, err := listCheaseePiImages(context.Background())
	if err != nil {
		t.Fatalf("listCheaseePiImages: %v", err)
	}
	// Never deduped by image ID — each full Repository:Tag stays an entry.
	if len(images) != 2 {
		t.Errorf("two tags of the same image must yield two entries, got %+v", images)
	}
	if images[0].Ref == images[1].Ref {
		t.Errorf("entries must differ by tag, got %+v", images)
	}
}

func TestRemoveImages_RemovesEachRefInOrder(t *testing.T) {
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		return &mockCmd{}
	})

	images := []cheaseePiImage{
		{Ref: "cheasee-pi-repoA-cheasee-pi:latest"},
		{Ref: "cheasee-pi-repoA-codeflow:latest"},
	}
	stderr := testutil.CaptureStderr(t, func() {
		if err := removeImages(context.Background(), images); err != nil {
			t.Fatalf("removeImages: %v", err)
		}
	})

	want := [][]string{
		{"image", "rm", "-f", "cheasee-pi-repoA-cheasee-pi:latest"},
		{"image", "rm", "-f", "cheasee-pi-repoA-codeflow:latest"},
	}
	if len(recorded) != 2 || !slices.Equal(recorded[0], want[0]) || !slices.Equal(recorded[1], want[1]) {
		t.Errorf("docker invocations = %v, want %v", recorded, want)
	}
	for _, ref := range []string{"cheasee-pi-repoA-cheasee-pi:latest", "cheasee-pi-repoA-codeflow:latest"} {
		if !strings.Contains(stderr, "Removed image "+ref) {
			t.Errorf("removal confirmation missing for %s, got %q", ref, stderr)
		}
	}
}

func TestRemoveImages_EmptyIsNoop(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		t.Errorf("no docker invocation expected for empty refs, got %v %v", name, arg)
		return &mockCmd{}
	})
	if err := removeImages(context.Background(), nil); err != nil {
		t.Fatalf("removeImages(nil): %v", err)
	}
}

func TestRemoveImages_FailureAborts(t *testing.T) {
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		if slices.Contains(arg, "cheasee-pi-repoB-codeflow:latest") {
			return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("conflict") }}
		}
		return &mockCmd{}
	})

	images := []cheaseePiImage{
		{Ref: "cheasee-pi-repoA-cheasee-pi:latest"},
		{Ref: "cheasee-pi-repoB-codeflow:latest"},
		{Ref: "cheasee-pi-repoC-cheasee-pi:latest"},
	}
	err := removeImages(context.Background(), images)
	if err == nil || !strings.Contains(err.Error(), "cheasee-pi-repoB-codeflow:latest") {
		t.Fatalf("rm failure must surface naming the ref, got %v", err)
	}
	// Abort, no silent partial clean: the third ref is never attempted.
	if len(recorded) != 2 {
		t.Errorf("failed rm must stop the loop (2 calls), got %d: %v", len(recorded), recorded)
	}
}

func TestPruneAllBuildCache_InvokesWithA(t *testing.T) {
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		return &mockCmd{}
	})
	testutil.CaptureStderr(t, func() { pruneAllBuildCache(context.Background()) })
	if len(recorded) != 1 || !slices.Equal(recorded[0], []string{"buildx", "prune", "-a", "-f"}) {
		t.Errorf("pruneAllBuildCache must invoke docker buildx prune -a -f, got %v", recorded)
	}
}

func TestPruneAllBuildCache_FailureSurfaces(t *testing.T) {
	// A docker failure must surface as an error — never silent success while
	// the cache the removed images pinned stays on disk.
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
	})
	err := pruneAllBuildCache(context.Background())
	if err == nil || !strings.Contains(err.Error(), "docker buildx prune") || !strings.Contains(err.Error(), "daemon down") {
		t.Fatalf("buildx prune failure must surface wrapped, got %v", err)
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

func TestPruneBuildCache_InvokesWithoutA(t *testing.T) {
	// Regression: clean's cache blast radius is unchanged — no -a added.
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		return &mockCmd{}
	})
	testutil.CaptureStderr(t, func() { pruneBuildCache() })
	if len(recorded) != 1 || !slices.Equal(recorded[0], []string{"buildx", "prune", "-f"}) {
		t.Errorf("pruneBuildCache must invoke docker buildx prune -f (no -a), got %v", recorded)
	}
}

// ──────────────────────────────────────────────
// Phase 2: runPruneImagesE orchestration
// ──────────────────────────────────────────────

func TestRunPruneImagesE_gateAbortsWithAnyManagedContainer(t *testing.T) {
	// A stopped container and a running container both block: force-removing
	// a running container's image is a hard Docker conflict (-f cannot force)
	// and force-removing a stopped one silently orphans it. The gate is
	// state-agnostic by construction — both states exercise the same abort.
	resetPruneState(t)
	for _, state := range []string{"stopped", "running"} {
		calls := pruneTestStub(t, []string{"cheasee-pi-repoA"}, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\n", "")
		err := runPruneImagesE(pruneImagesCmd, nil)
		if err == nil || !strings.Contains(err.Error(), "cheasee-pi clean") {
			t.Fatalf("%s container: gate must abort pointing at `cheasee-pi clean`, got %v", state, err)
		}
		assertNoMutations(t, calls)
	}
}

func TestRunPruneImagesE_yesNeverBypassesGate(t *testing.T) {
	resetPruneState(t)
	pruneImagesYes = true
	calls := pruneTestStub(t, []string{"cheasee-pi-repoA"}, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\n", "")
	err := runPruneImagesE(pruneImagesCmd, nil)
	if err == nil || !strings.Contains(err.Error(), "cheasee-pi clean") {
		t.Fatalf("--yes must not bypass the gate, got %v", err)
	}
	assertNoMutations(t, calls)
}

func TestRunPruneImagesE_gateFailureSurfaces(t *testing.T) {
	resetPruneState(t)
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "ps" {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
		}
		return &mockCmd{}
	})
	err := runPruneImagesE(pruneImagesCmd, nil)
	if err == nil || !strings.Contains(err.Error(), "prune-images:") || !strings.Contains(err.Error(), "daemon down") {
		t.Fatalf("gate failure must surface wrapped, got %v", err)
	}
}

func TestRunPruneImagesE_enumerationFailureSurfaces(t *testing.T) {
	resetPruneState(t)
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		if len(arg) > 1 && arg[0] == "image" && arg[1] == "ls" {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
		}
		return &mockCmd{}
	})
	err := runPruneImagesE(pruneImagesCmd, nil)
	if err == nil || !strings.Contains(err.Error(), "enumerate images") {
		t.Fatalf("enumeration failure must surface wrapped, got %v", err)
	}
}

func TestRunPruneImagesE_dryRunListsImages(t *testing.T) {
	resetPruneState(t)
	pruneImagesDryRun = true
	calls := pruneTestStub(t, nil, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\ncheasee-pi-repoA-codeflow:latest|1.2GB\n", "")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	for _, want := range []string{
		"cheasee-pi-repoA-cheasee-pi:latest", "cheasee-pi-repoA-codeflow:latest",
		"3.4GB", "1.2GB", "≈", "Dry-run",
	} {
		if !strings.Contains(stderr, want) {
			t.Errorf("dry-run must report %q, got %q", want, stderr)
		}
	}
	assertNoMutations(t, calls)
}

func TestRunPruneImagesE_dryRunNoImages(t *testing.T) {
	resetPruneState(t)
	pruneImagesDryRun = true
	calls := pruneTestStub(t, nil, "", "")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	if !strings.Contains(stderr, "No cheasee-pi images found") {
		t.Errorf("dry-run with zero images must say so, got %q", stderr)
	}
	if !strings.Contains(stderr, "Dry-run") {
		t.Errorf("dry-run must still be reported, got %q", stderr)
	}
	assertNoMutations(t, calls)
}

func TestRunPruneImagesE_dryRunYesComboStaysReportOnly(t *testing.T) {
	const imageLS = "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\n"

	// --dry-run alone.
	resetPruneState(t)
	pruneImagesDryRun = true
	dryCalls := pruneTestStub(t, nil, imageLS, "")
	dryStderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	assertNoMutations(t, dryCalls)

	// --dry-run --yes: byte-identical to --dry-run alone (dry-run wins).
	resetPruneState(t)
	pruneImagesDryRun = true
	pruneImagesYes = true
	comboCalls := pruneTestStub(t, nil, imageLS, "")
	comboStderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	if comboStderr != dryStderr {
		t.Errorf("--dry-run --yes must match dry-run alone:\ncombo:   %q\ndry-run: %q", comboStderr, dryStderr)
	}
	assertNoMutations(t, comboCalls)
}

func TestRunPruneImagesE_confirmAbortTouchesNothing(t *testing.T) {
	resetPruneState(t)
	pruneImagesConfirmFn = func(string) (bool, error) { return false, nil }
	calls := pruneTestStub(t, nil, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\n", "")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	if !strings.Contains(stderr, "Aborted") {
		t.Errorf("abort must be reported, got %q", stderr)
	}
	if strings.Contains(stderr, "Removed image") {
		t.Errorf("aborted run must not remove images, got %q", stderr)
	}
	assertNoMutations(t, calls)
}

func TestRunPruneImagesE_confirmPromptDisclosesCountAndCache(t *testing.T) {
	resetPruneState(t)
	var prompt string
	pruneImagesConfirmFn = func(p string) (bool, error) { prompt = p; return false, nil }
	pruneTestStub(t, nil, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\ncheasee-pi-repoA-codeflow:latest|1.2GB\n", "")
	testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	if !strings.Contains(prompt, "2") {
		t.Errorf("prompt must state the image count, got %q", prompt)
	}
	if !strings.Contains(prompt, "cache") {
		t.Errorf("prompt must disclose the host-wide cache blast radius, got %q", prompt)
	}
}

func TestRunPruneImagesE_confirmRemovesAllImages(t *testing.T) {
	// No keep-latest: every tagged image is removed, newest and oldest alike.
	resetPruneState(t)
	pruneImagesConfirmFn = func(string) (bool, error) { return true, nil }
	calls := pruneTestStub(t, nil, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\ncheasee-pi-repoA-cheasee-pi:v2|0.9GB\n", "")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	for _, ref := range []string{"cheasee-pi-repoA-cheasee-pi:latest", "cheasee-pi-repoA-cheasee-pi:v2"} {
		if !strings.Contains(stderr, "Removed image "+ref) {
			t.Errorf("confirmed run must remove %s, got %q", ref, stderr)
		}
	}
	var rmRefs []string
	for _, arg := range *calls {
		if len(arg) > 1 && arg[0] == "image" && arg[1] == "rm" {
			rmRefs = append(rmRefs, arg[len(arg)-1])
		}
	}
	if len(rmRefs) != 2 {
		t.Errorf("expected exactly 2 image rm calls, got %v", rmRefs)
	}
}

func TestRunPruneImagesE_yesOrdersRemoveThenPrune(t *testing.T) {
	// Cache reclaim only works after the tagged images that pinned it are
	// gone: every image rm precedes image prune, which precedes buildx -a.
	resetPruneState(t)
	pruneImagesYes = true
	calls := pruneTestStub(t, nil, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\ncheasee-pi-repoA-codeflow:latest|1.2GB\n", "")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("runPruneImagesE: %v", err)
		}
	})
	if !strings.Contains(stderr, "Removed image cheasee-pi-repoA-cheasee-pi:latest") {
		t.Errorf("--yes run must remove the first ref, got %q", stderr)
	}
	if !strings.Contains(stderr, "Pruned dangling Docker images") {
		t.Errorf("--yes run must prune dangling images, got %q", stderr)
	}
	if !strings.Contains(stderr, "Pruned Docker build cache (all projects)") {
		t.Errorf("--yes run must prune the build cache host-wide, got %q", stderr)
	}

	lastRm, pruneIdx, buildxIdx := -1, -1, -1
	for i, arg := range *calls {
		switch {
		case len(arg) > 1 && arg[0] == "image" && arg[1] == "rm":
			lastRm = i
		case len(arg) > 1 && arg[0] == "image" && arg[1] == "prune":
			pruneIdx = i
		case len(arg) > 0 && arg[0] == "buildx" && slices.Contains(arg, "-a"):
			buildxIdx = i
		}
	}
	if lastRm == -1 || pruneIdx == -1 || buildxIdx == -1 {
		t.Fatalf("expected image rm, image prune and buildx prune -a calls, got %v", *calls)
	}
	if lastRm >= pruneIdx {
		t.Errorf("every image rm must precede image prune (lastRm=%d, pruneIdx=%d)", lastRm, pruneIdx)
	}
	if pruneIdx >= buildxIdx {
		t.Errorf("image prune must precede buildx prune -a (pruneIdx=%d, buildxIdx=%d)", pruneIdx, buildxIdx)
	}
}

func TestRunPruneImagesE_rmFailureSurfaces(t *testing.T) {
	resetPruneState(t)
	pruneImagesYes = true
	calls := pruneTestStub(t, nil, "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\ncheasee-pi-repoA-codeflow:latest|1.2GB\n", "cheasee-pi-repoA-codeflow:latest")
	stderr := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			if !strings.Contains(err.Error(), "cheasee-pi-repoA-codeflow:latest") {
				t.Errorf("error must name the failed ref, got %v", err)
			}
			return
		}
		t.Error("rm failure must surface as an error")
	})
	// No success summary for the full run: mutation stops mid-loop.
	if strings.Contains(stderr, "Pruned Docker build cache") {
		t.Errorf("failed run must not prune the cache, got %q", stderr)
	}
	for _, arg := range *calls {
		if len(arg) > 0 && arg[0] == "buildx" {
			t.Errorf("failed run must not reach buildx prune, got %v", arg)
		}
	}
}

func TestRunPruneImagesE_rerunEmptyIsIdempotent(t *testing.T) {
	resetPruneState(t)
	pruneImagesYes = true
	calls := pruneTestStub(t, nil, "", "")
	testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(pruneImagesCmd, nil); err != nil {
			t.Fatalf("re-run after everything is gone must succeed, got %v", err)
		}
	})
	for _, arg := range *calls {
		if len(arg) > 1 && arg[0] == "image" && arg[1] == "rm" {
			t.Errorf("empty enumeration must issue zero image rm, got %v", arg)
		}
	}
}

// ──────────────────────────────────────────────
// Phase 3: operator journey via rootCmd
// ──────────────────────────────────────────────

func TestPruneImages_Journey(t *testing.T) {
	resetPruneState(t)
	const imageLS = "cheasee-pi-repoA-cheasee-pi:latest|3.4GB\ncheasee-pi-repoA-codeflow:latest|1.2GB\n"

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
	for _, want := range []string{"cheasee-pi-repoA-cheasee-pi:latest", "cheasee-pi-repoA-codeflow:latest", "Dry-run"} {
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
