package main

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// Harness: build/rebuild seams
// ──────────────────────────────────────────────

// resetBuildState pins the build/rebuild package vars for the duration of a
// test. The vars are shared across the build and rebuild commands (one
// command per process), so a test must reset them before and after.
func resetBuildState(t *testing.T) {
	t.Helper()
	buildWorkdir = ""
	buildNoDockerCheck = false
	t.Cleanup(func() {
		buildWorkdir = ""
		buildNoDockerCheck = false
	})
}

// buildWorkspaceFixture creates a real git worktree (bare clone + worktree
// add via the real git binary) with cheasee-settings.json, so the repository
// root and bareRepoURL resolve against genuine git state. Returns the worktree
// root.

func buildWorkspaceFixture(t *testing.T) string {
	t.Helper()
	src := gitRemoteFixture(t, "main")
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	cloneWorktreeLayout(t, src, parent, root)
	testutil.WriteCheaseeSettingsFile(t, root, "{}")
	return root
}

// buildTestStub installs the docker seams for the build/rebuild core and
// records every docker invocation into one serial call log (order matters:
// pre- vs post-build prune is a pinned behavior). git commands fall through
// to the real binary — the repository root and bareRepoURL need genuine git
// state from the workspace fixture.

type buildTestStub struct {
	log        []string   // serial log of every docker invocation ("run:"/ "exec:" prefixed)
	compose    []*mockCmd // captured compose build runners (env/dir assertions)
	buildErr   error      // when non-nil, the compose build Run returns it
	pruneErr   error      // when non-nil, prune-era commands fail (best-effort swallow)
	noDangling bool       // when true, `docker images --filter dangling=true -q` returns empty
}

func (s *buildTestStub) install(t *testing.T) {
	t.Helper()
	// Ample free space by default: the disk gate now runs inside every
	// compose build (docker info --format below), and these tests exercise the
	// build core, not the gate.
	stubStatfsAmple(t)
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return saved(ctx, name, arg...) // git (repository root, git runner, bareRepoURL)
		}
		switch {
		case slices.Contains(arg, "{{.DockerRootDir}}"): // disk gate: docker info --format
			// Not a build invocation — keep it out of the log/compose capture so
			// per-test invocation counts stay stable.
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("/var/lib/docker\n"), nil }}
		case slices.Contains(arg, "images"): // docker images --filter dangling=true -q
			s.log = append(s.log, "exec:"+strings.Join(append([]string{name}, arg...), " "))
			if s.noDangling {
				return &mockCmd{outputFn: func() ([]byte, error) { return nil, nil }}
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("sha256:abc\n"), nil }}
		case len(arg) > 0 && (arg[0] == "image" || arg[0] == "buildx"): // docker image prune -f / buildx prune -f
			s.log = append(s.log, "exec:"+strings.Join(append([]string{name}, arg...), " "))
			return &mockCmd{combinedFn: func() ([]byte, error) { return nil, s.pruneErr }}
		}
		s.log = append(s.log, "run:"+strings.Join(append([]string{name}, arg...), " "))
		c := &mockCmd{runFn: func() error { return s.buildErr }}
		s.compose = append(s.compose, c)
		return c
	})
}

// logPrefixes returns the index of the first log entry with the given prefix.

func logIndex(log []string, prefix string) int {
	return slices.IndexFunc(log, func(s string) bool { return strings.HasPrefix(s, prefix) })
}

// composeArgv returns the captured compose-build argv ("docker compose -f ...")
// from the serial log, or nil when no compose build ran.

func (s *buildTestStub) composeArgv() []string {
	for _, entry := range s.log {
		if strings.HasPrefix(entry, "run:docker compose") {
			return strings.Split(strings.TrimPrefix(entry, "run:"), " ")
		}
	}
	return nil
}

// ──────────────────────────────────────────────
// Phase 1: command registration + help surface
// ──────────────────────────────────────────────

func TestRebuildCmd_Registered(t *testing.T) {
	found := false
	for _, c := range rootCmd.Commands() {
		if c.Name() == "rebuild" {
			found = true
			if c.RunE == nil {
				t.Error("rebuildCmd.RunE must be non-nil (use RunE, not Run)")
			}
			if !c.DisableAutoGenTag {
				t.Error("rebuildCmd.DisableAutoGenTag should be true")
			}
		}
	}
	if !found {
		t.Error("rebuildCmd must be registered on rootCmd")
	}
}

func TestRebuildCmd_Flags(t *testing.T) {
	if rebuildCmd.Flags().Lookup("workdir") == nil {
		t.Error("rebuild must expose --workdir")
	}
	if rebuildCmd.Flags().Lookup("no-docker-check") == nil {
		t.Error("rebuild must expose --no-docker-check")
	}
	if rebuildCmd.Flags().Lookup("no-cache") != nil {
		t.Error("rebuild must NOT expose --no-cache (no-cache is inherent to the command)")
	}
}
