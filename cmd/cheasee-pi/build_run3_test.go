package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

func TestRunRebuildE_DockerCheckRespected(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = false // default: the check runs
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	versionCalls := 0
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "git" {
			return saved(ctx, name, arg...)
		}
		if len(arg) > 0 && arg[0] == "version" {
			versionCalls++
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("28.0.0"), nil }}
		}
		return &mockCmd{runFn: func() error { return nil }} // docker info + compose build
	})
	stubLookPath(t, func(string) (string, error) { return "/usr/bin/docker", nil })
	stderr := testutil.CaptureStderr(t, func() {
		if err := runRebuildE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runRebuildE: %v", err)
		}
	})
	if versionCalls == 0 {
		t.Error("default rebuild must run the Docker Engine check")
	}
	if !strings.Contains(stderr, "installed and running") {
		t.Errorf("docker check confirmation missing, got %q", stderr)
	}

	// buildNoDockerCheck=true skips the check entirely.
	resetBuildState(t)
	buildNoDockerCheck = true
	versionCalls = 0
	stub := &buildTestStub{}
	stub.install(t)
	if err := runRebuildE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runRebuildE with no-docker-check: %v", err)
	}
	for _, entry := range stub.log {
		if strings.HasPrefix(entry, "run:docker version") || strings.HasPrefix(entry, "run:docker info") {
			t.Errorf("docker check must be skipped with buildNoDockerCheck=true, log: %v", stub.log)
		}
	}
}

// ──────────────────────────────────────────────
// Phase 5: user-journey + docs
// ──────────────────────────────────────────────

func TestRunRebuildE_Journey_OutputFlow(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{}
	stub.install(t)
	stderr := testutil.CaptureStderr(t, func() {
		if err := runRebuildE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runRebuildE: %v", err)
		}
	})

	// Full user-visible sequence: full-rebuild label (distinct from the
	// cached-build label) → image built → prune confirmations.
	if !strings.Contains(stderr, "Building container image (no cache), full rebuild") {
		t.Errorf("rebuild label with full-rebuild marker missing, got %q", stderr)
	}
	if strings.Contains(stderr, "Building container image...\n") {
		t.Errorf("rebuild must not use the plain cached-build label, got %q", stderr)
	}
	if !strings.Contains(stderr, "✓ Image built") {
		t.Errorf("build confirmation missing, got %q", stderr)
	}
	if !strings.Contains(stderr, "✓ Pruned dangling Docker images") {
		t.Errorf("dangling-image prune confirmation missing, got %q", stderr)
	}
	if !strings.Contains(stderr, "✓ Pruned Docker build cache") {
		t.Errorf("build-cache prune confirmation missing, got %q", stderr)
	}
	// No container lifecycle output — that belongs to clean.
	for _, forbidden := range []string{"Killed", "Removed container", "container cheasee-pi"} {
		if strings.Contains(stderr, forbidden) {
			t.Errorf("rebuild must show no container lifecycle output, got %q", stderr)
		}
	}
}

func TestDailyUsageDoc_RebuildCommand(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "daily-usage.md"))
	if err != nil {
		t.Fatalf("reading docs/daily-usage.md: %v", err)
	}
	content := string(data)
	start := strings.Index(content, "### Full rebuild")
	if start == -1 {
		t.Fatal("daily-usage.md must have a '### Full rebuild' section")
	}
	section := content[start:]

	if !strings.Contains(section, "cheasee-pi rebuild") {
		t.Error("the Full rebuild section must list 'cheasee-pi rebuild' as the primary path")
	}
	if !strings.Contains(section, "rebuild = no-cache full rebuild + prune") {
		t.Error("the section must state 'rebuild = no-cache full rebuild + prune' (naming inversion vs VS Code)")
	}
	// The raw compose line keeps --no-cache --pull (direct docker compose, not
	// the CLI flag); the CLI alias `cheasee-pi build --no-cache` must be gone.
	if strings.Contains(section, "cheasee-pi build --no-cache") {
		t.Error("the section must not claim 'cheasee-pi build --no-cache' as a compat path (rebuild is the only no-cache path)")
	}
}
