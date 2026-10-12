package main

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

func TestRunRebuildE_PrunesAfterBuild(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{}
	stub.install(t)
	if err := runRebuildE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runRebuildE: %v", err)
	}
	composeIdx := logIndex(stub.log, "run:docker compose")
	imagesIdx := logIndex(stub.log, "exec:docker images")
	pruneIdx := logIndex(stub.log, "exec:docker image prune")
	buildxIdx := logIndex(stub.log, "exec:docker buildx")
	if composeIdx == -1 || imagesIdx == -1 || pruneIdx == -1 || buildxIdx == -1 {
		t.Fatalf("expected compose build + post-build prune sequence, log: %v", stub.log)
	}
	if !(composeIdx < imagesIdx && imagesIdx < pruneIdx && pruneIdx < buildxIdx) {
		t.Errorf("rebuild must prune AFTER the build, in order, log: %v", stub.log)
	}
}

func TestRunRebuildE_PruneScope(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{}
	stub.install(t)
	if err := runRebuildE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runRebuildE: %v", err)
	}
	for _, entry := range stub.log {
		for _, forbidden := range []string{" docker ps", " docker rm", "system prune", " docker stop"} {
			if strings.Contains(entry, forbidden) {
				t.Errorf("rebuild must not touch containers (container lifecycle belongs to clean), got %q", entry)
			}
		}
	}
}

func TestRunRebuildE_NoDanglingImagesSkipsImagePrune(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{noDangling: true}
	stub.install(t)
	if err := runRebuildE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runRebuildE: %v", err)
	}
	if logIndex(stub.log, "exec:docker image prune") != -1 {
		t.Errorf("no dangling images → docker image prune must be skipped, log: %v", stub.log)
	}
	if logIndex(stub.log, "exec:docker buildx") == -1 {
		t.Errorf("build-cache prune runs regardless, log: %v", stub.log)
	}
}

func TestRunRebuildE_PruneFailureDoesNotFailBuild(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{pruneErr: fmt.Errorf("docker daemon hiccup")}
	stub.install(t)
	stderr := testutil.CaptureStderr(t, func() {
		if err := runRebuildE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runRebuildE: %v", err)
		}
	})
	if !strings.Contains(stderr, "✓ Image built") {
		t.Errorf("prune failure must not fail the rebuild, got %q", stderr)
	}
}

// ──────────────────────────────────────────────
// Phase 4: error paths + boundaries
// ──────────────────────────────────────────────

func TestRunRebuildE_BuildFailureSurfaces(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{buildErr: fmt.Errorf("compose exploded")}
	stub.install(t)
	err := runRebuildE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "docker compose build:") || !strings.Contains(err.Error(), "compose exploded") {
		t.Fatalf("compose failure must wrap as 'docker compose build:', got %v", err)
	}
	if logIndex(stub.log, "exec:docker") != -1 {
		t.Errorf("prunes must be SKIPPED after a failed build, log: %v", stub.log)
	}
}

func TestRunRebuildE_NotAGitRepoSurfaces(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	chdir(t, t.TempDir()) // plain dir, no git worktree

	err := runRebuildE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "not a git repository") {
		t.Fatalf("non-git workdir must surface 'not a git repository', got %v", err)
	}
}

func TestRunRebuildE_WorkdirFlagRespected(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	rootB := buildWorkspaceFixture(t)
	// cwd is a plain non-git dir: if --workdir were ignored, resolveWorkdir
	// would return it and repoRoot would fail loudly.
	chdir(t, t.TempDir())
	buildWorkdir = rootB

	stub := &buildTestStub{}
	stub.install(t)
	if err := runRebuildE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runRebuildE: %v", err)
	}
	if len(stub.compose) != 1 {
		t.Fatalf("expected one compose build, got %d", len(stub.compose))
	}
	env := stub.compose[0].env
	if !slices.Contains(env, "WORKSPACE_HOST_PATH="+rootB) {
		t.Errorf("compose env must target the --workdir workspace, got %v", env)
	}
}
