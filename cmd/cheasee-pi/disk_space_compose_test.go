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

// ──────────────────────────────────────────────
// Phase 2: build choke point
// ──────────────────────────────────────────────

func TestComposeBuild_LowDiskRefusedBeforeRun(t *testing.T) {
	composeRuns := recordCompose(t, "/var/lib/docker")
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)
	err := composeBuild(context.Background(), t.TempDir(), t.TempDir(), "cheasee-pi-x", composeBuildSpec{label: "Building container image"})
	if err == nil || !strings.Contains(err.Error(), "cheasee-pi clean") {
		t.Fatalf("low free space must refuse with the reclaim hint, got %v", err)
	}
	if *composeRuns != 0 {
		t.Errorf("refused build must not invoke docker compose, got %d", *composeRuns)
	}
}

func TestComposeBuild_LowDiskErrorNotWrapped(t *testing.T) {
	recordCompose(t, "/var/lib/docker")
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)
	err := composeBuild(context.Background(), t.TempDir(), t.TempDir(), "cheasee-pi-x", composeBuildSpec{
		label:   "Building container image",
		wrapErr: func(e error) error { return fmt.Errorf("docker compose build: %w", e) },
	})
	if err == nil || strings.Contains(err.Error(), "docker compose build:") {
		t.Fatalf("disk refusal must not be wrapped as a compose failure, got %v", err)
	}
}

func TestComposeBuild_AmpleDisk_OneComposeInvocation(t *testing.T) {
	composeRuns := recordCompose(t, "/var/lib/docker")
	stubStatfsBytes(t, uint64(minBuildFreeBytes))
	stderr := testutil.CaptureStderr(t, func() {
		if err := composeBuild(context.Background(), t.TempDir(), t.TempDir(), "cheasee-pi-x", composeBuildSpec{label: "Building container image"}); err != nil {
			t.Fatalf("ample free space must build, got %v", err)
		}
	})
	if *composeRuns != 1 {
		t.Errorf("ample free space must run exactly one compose build, got %d", *composeRuns)
	}
	if !strings.Contains(stderr, "Building container image") {
		t.Errorf("label missing, got %q", stderr)
	}
}

func TestRunBuildE_LowDisk_NoCompose(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	chdir(t, buildWorkspaceFixture(t))

	stub := &buildTestStub{}
	stub.install(t)
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)

	err := runBuildE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "cheasee-pi clean") {
		t.Fatalf("cached build below the threshold must refuse, got %v", err)
	}
	if len(stub.compose) != 0 {
		t.Errorf("refused build must not run compose, got %d", len(stub.compose))
	}
}

func TestRunRebuildE_LowDisk_NoComposeNoPrune(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	chdir(t, buildWorkspaceFixture(t))

	stub := &buildTestStub{}
	stub.install(t)
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)

	err := runRebuildE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "cheasee-pi clean") {
		t.Fatalf("no-cache rebuild below the threshold must refuse, got %v", err)
	}
	if len(stub.log) != 0 {
		t.Errorf("refused rebuild must run no docker command, got %v", stub.log)
	}
}

func TestRunBuildE_LowDiskRefusedWithNoDockerCheck(t *testing.T) {
	// --no-docker-check skips the availability gate, never the capacity gate.
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	chdir(t, buildWorkspaceFixture(t))

	stub := &buildTestStub{}
	stub.install(t)
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)

	err := runBuildE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "not enough free space") {
		t.Fatalf("the disk gate must be independent of --no-docker-check, got %v", err)
	}
	if len(stub.compose) != 0 {
		t.Errorf("refused build must not run compose, got %d", len(stub.compose))
	}
}

// ──────────────────────────────────────────────
// Phase 3: start-path transitivity
// ──────────────────────────────────────────────

func TestDockerComposeUp_LowDiskRefusesBeforeCompose(t *testing.T) {
	// The bug's start-triggered rebuild: ensureContainerReady → dockerComposeUp
	// → composeBuild must inherit the gate, so no compose up ever runs.
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)

	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		return &mockCmd{}
	})
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)

	_, err := ensureContainerReady(context.Background(), root, containerName(root), false)
	if err == nil || !strings.Contains(err.Error(), "cheasee-pi clean") {
		t.Fatalf("start-path rebuild must refuse on low disk, got %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("refused start must not invoke compose, got %v", c.composeArgs)
	}
}
