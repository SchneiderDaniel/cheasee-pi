package main

import (
	"context"
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"slices"
	"strings"
	"testing"
)

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

// TestListCheaseePiImages_includesUI (AC5): the `ui` service's built image is
// `cheasee-pi-<slug>-ui`, which imageNamePrefix already covers — no code change,
// but a regression pin that prune-images never drops the sidecar image.

// TestListCheaseePiImages_includesUI (AC5): the `ui` service's built image is
// `cheasee-pi-<slug>-ui`, which imageNamePrefix already covers — no code change,
// but a regression pin that prune-images never drops the sidecar image.
func TestListCheaseePiImages_includesUI(t *testing.T) {
	const ui = "cheasee-pi-repoA-ui:latest"
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		return &mockCmd{outputFn: func() ([]byte, error) {
			return []byte("cheasee-pi-repoA-cheasee-pi:latest|3.4GB\n" + ui + "|0.9GB\n"), nil
		}}
	})

	images, err := listCheaseePiImages(context.Background())
	if err != nil {
		t.Fatalf("listCheaseePiImages: %v", err)
	}
	if !slices.ContainsFunc(images, func(img cheaseePiImage) bool { return img.Ref == ui }) {
		t.Errorf("listCheaseePiImages must include %s, got %v", ui, images)
	}
	if !isCheaseePiImageRef(ui) {
		t.Errorf("isCheaseePiImageRef(%q) = false, want true", ui)
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

func TestPruneBuildCache_AllInvokesWithA(t *testing.T) {
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		return &mockCmd{}
	})
	if err := pruneBuildCache(context.Background(), true); err != nil {
		t.Fatalf("pruneBuildCache(all): %v", err)
	}
	if len(recorded) != 1 || !slices.Equal(recorded[0], []string{"buildx", "prune", "-a", "-f"}) {
		t.Errorf("pruneBuildCache(all=true) must invoke docker buildx prune -a -f, got %v", recorded)
	}
}

func TestPruneBuildCache_AllFailureSurfaces(t *testing.T) {
	// A docker failure must surface as an error — never silent success while
	// the cache the removed images pinned stays on disk.
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
	})
	err := pruneBuildCache(context.Background(), true)
	if err == nil || !strings.Contains(err.Error(), "docker buildx prune") || !strings.Contains(err.Error(), "daemon down") {
		t.Fatalf("buildx prune failure must surface wrapped, got %v", err)
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
	if err := pruneBuildCache(context.Background(), false); err != nil {
		t.Fatalf("pruneBuildCache: %v", err)
	}
	if len(recorded) != 1 || !slices.Equal(recorded[0], []string{"buildx", "prune", "-f"}) {
		t.Errorf("pruneBuildCache must invoke docker buildx prune -f (no -a), got %v", recorded)
	}
}

// ──────────────────────────────────────────────
// Phase 2: runPruneImagesE orchestration
// ──────────────────────────────────────────────

func TestPruneDanglingImages_GatedSkipsWhenEmpty(t *testing.T) {
	// Empty dangling list → the prune must not run (build/clean avoid a daemon
	// round-trip on every cached build).
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		return &mockCmd{} // docker images -q → empty
	})
	if err := pruneDanglingImages(context.Background(), true); err != nil {
		t.Fatalf("gated prune must swallow: %v", err)
	}
	if len(recorded) != 1 || !slices.Equal(recorded[0], []string{"images", "--filter", "dangling=true", "-q"}) {
		t.Errorf("gated prune with no dangling images must issue only the list query, got %v", recorded)
	}
}
