package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// Phase 1: policy adapter
// ──────────────────────────────────────────────

func TestCheckBuildDiskSpace_AboveThreshold_NoError(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	stubStatfsBytes(t, uint64(minBuildFreeBytes)+1)
	if err := checkBuildDiskSpace(context.Background()); err != nil {
		t.Fatalf("free space above the threshold must pass, got %v", err)
	}
}

func TestCheckBuildDiskSpace_AtThreshold_NoError(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	stubStatfsBytes(t, uint64(minBuildFreeBytes))
	if err := checkBuildDiskSpace(context.Background()); err != nil {
		t.Fatalf("exactly the threshold must pass (boundary is <), got %v", err)
	}
}

func TestCheckBuildDiskSpace_BelowThreshold_ActionableError(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)
	err := checkBuildDiskSpace(context.Background())
	if err == nil {
		t.Fatal("free space below the threshold must refuse the build")
	}
	for _, want := range []string{"GiB", "10", "/var/lib/docker", "cheasee-pi clean", "cheasee-pi prune-images"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("refusal must name %q, got %v", want, err)
		}
	}
}

func TestCheckBuildDiskSpace_ZeroFree_Refuses(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	stubStatfsBytes(t, 0)
	err := checkBuildDiskSpace(context.Background())
	if err == nil {
		t.Fatal("zero free space must refuse the build")
	}
	if strings.Contains(err.Error(), "NaN") || strings.Contains(err.Error(), "Inf") {
		t.Errorf("zero-free refusal must format cleanly, got %v", err)
	}
}

func TestCheckBuildDiskSpace_StatfsError_FailsOpen(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	stubStatfs(t, func(string) (uint64, error) { return 0, fmt.Errorf("statfs boom") })
	stderr := testutil.CaptureStderr(t, func() {
		if err := checkBuildDiskSpace(context.Background()); err != nil {
			t.Fatalf("undeterminable free space must fail open, got %v", err)
		}
	})
	if !strings.Contains(stderr, "skipping the build free-space check") {
		t.Errorf("statfs failure must warn on stderr, got %q", stderr)
	}
}

func TestCheckBuildDiskSpace_DataRootError_FailsOpen(t *testing.T) {
	stubDockerInfoRoot(t, "", fmt.Errorf("daemon down"))
	// Zero free: if the gate probed the disk anyway, it would refuse.
	stubStatfsBytes(t, 0)
	stderr := testutil.CaptureStderr(t, func() {
		if err := checkBuildDiskSpace(context.Background()); err != nil {
			t.Fatalf("unresolvable data root must fail open, got %v", err)
		}
	})
	if !strings.Contains(stderr, "skipping the build free-space check") {
		t.Errorf("data-root failure must warn on stderr, got %q", stderr)
	}
}

func TestCheckBuildDiskSpace_EmptyDataRoot_FailsOpen(t *testing.T) {
	stubDockerInfoRoot(t, "   \n", nil)
	stubStatfsBytes(t, 0)
	stderr := testutil.CaptureStderr(t, func() {
		if err := checkBuildDiskSpace(context.Background()); err != nil {
			t.Fatalf("empty data root must fail open, got %v", err)
		}
	})
	if !strings.Contains(stderr, "skipping the build free-space check") {
		t.Errorf("empty data root must warn on stderr, got %q", stderr)
	}
}

func TestDockerDataRoot_TrimsWhitespace(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	root, err := dockerDataRoot(context.Background())
	if err != nil || root != "/var/lib/docker" {
		t.Fatalf("dockerDataRoot = %q, %v; want /var/lib/docker", root, err)
	}
}

func TestDockerDataRoot_StatfsReceivesResolvedPath(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	var got string
	stubStatfs(t, func(p string) (uint64, error) { got = p; return uint64(minBuildFreeBytes), nil })
	if err := checkBuildDiskSpace(context.Background()); err != nil {
		t.Fatalf("checkBuildDiskSpace: %v", err)
	}
	if got != "/var/lib/docker" {
		t.Errorf("statfsFn received %q, want the resolved data root", got)
	}
}

func TestMinBuildFreeBytes_DocumentedThreshold(t *testing.T) {
	if minBuildFreeBytes != 10<<30 {
		t.Errorf("minBuildFreeBytes = %d, want the documented 10 GiB (10<<30)", minBuildFreeBytes)
	}
}

// ──────────────────────────────────────────────
// Phase 4: platform probe smoke
// ──────────────────────────────────────────────

func TestPlatformFreeBytes_TempDir(t *testing.T) {
	free, err := platformFreeBytes(t.TempDir())
	if err != nil {
		t.Fatalf("platformFreeBytes: %v", err)
	}
	if free == 0 {
		t.Error("expected >0 free bytes on a real temp dir")
	}
}

// ──────────────────────────────────────────────
// Phase 5: docs contract
// ──────────────────────────────────────────────

func TestInstallationDoc_BuildDisk(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "installation.md"))
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)
	for _, want := range []string{"10 GiB", "DockerRootDir", "cheasee-pi clean", "cheasee-pi prune-images"} {
		if !strings.Contains(content, want) {
			t.Errorf("installation.md must document %q in the build disk-space contract", want)
		}
	}
}

func TestCLIDoc_BuildDisk(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "cli.md"))
	if err != nil {
		t.Fatalf("reading docs/cli.md: %v", err)
	}
	start := strings.Index(string(data), "## `cheasee-pi build` / `rebuild`")
	if start == -1 {
		t.Fatal("cli.md must have a build/rebuild section")
	}
	section := string(data)[start:]
	if end := strings.Index(section[1:], "\n## "); end != -1 {
		section = section[:end+1]
	}
	for _, want := range []string{"10 GiB", "free space", "cheasee-pi clean", "cheasee-pi prune-images"} {
		if !strings.Contains(section, want) {
			t.Errorf("cli.md build/rebuild section must name %q", want)
		}
	}
}
