package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func withAuthListWorkdir(t *testing.T, workdir string) {
	t.Helper()
	saved := authListWorkdir
	authListWorkdir = workdir
	t.Cleanup(func() { authListWorkdir = saved })
}

// pinPassthroughEnv makes buildEnvFlags hermetic: fresh XDG_CONFIG_HOME,
// every passthrough env name cleared, and PATH pointing at a failing gh
// binary so GH_TOKEN extraction can't leak the host's real token into the map.

func pinPassthroughEnv(t *testing.T) string {
	t.Helper()
	xdg := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", xdg)
	for _, name := range AllEnvVarNames() {
		t.Setenv(name, "")
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	return xdg
}

// initDeps builds a runInit dependency set with the common test defaults:
// mocked ports, docker check enabled, GitHub flow enabled, no input, fresh
// workdir, confirming+empty-input fns. Override any field via opts, e.g.
// initDeps(t, func(d *InitDeps) { d.NoGitHub = true }).

func initDeps(t *testing.T, opts ...func(*InitDeps)) InitDeps {
	t.Helper()
	deps := InitDeps{
		Ports:         defaultMocks(),
		NoDockerCheck: false,
		NoGitHub:      false,
		NoInput:       true,
		Provider:      "opencode-go", // matches the --provider flag default
		Workdir:       t.TempDir(),
		ConfirmFn:     mockConfirmFn(true, nil),
		InputFn:       mockInputFn("", nil),
	}
	for _, opt := range opts {
		opt(&deps)
	}
	return deps
}

// initDepsWithRepoURL returns init deps configured for the GitHub clone path:
// interactive mode with a stubbed repo-URL input and API-key setup declined
// (the provider/model prompts are real huh TTY calls that would hang tests).
// The git identity prompt is skipped via SetGitConfig in callers.

func initDepsWithRepoURL(t *testing.T, workdir string, opts ...func(*InitDeps)) InitDeps {
	t.Helper()
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		// First input answers the repo URL prompt; the second the branch that
		// names the worktree folder (queue exhaustion → "" → default main).
		_, input := mockQueuePrompt(t, nil, []string{"owner/repo", "main"})
		d.InputFn = input
		d.ConfirmFn = mockConfirmFn(true, nil, "Configure API keys", "Add a custom skill repository")
	})
	for _, opt := range opts {
		opt(&deps)
	}
	return deps
}

// cloneCapture records the git clone/worktree argv captured during an init
// test via stubInitGit.

type cloneCapture struct {
	cloneArgs   [][]string
	worktreeAdd [][]string
}

// stubInitGit stubs the git seam for the init clone phase: captures argv and
// materializes the bare dir + worktree .git file so later phases (scaffold,
// gitignore append) see a plausible workspace. Non-git commands fall through
// to the previously-installed seam (e.g. a docker stub installed first).

func stubInitGit(t *testing.T) *cloneCapture {
	t.Helper()
	c := &cloneCapture{}
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "git" {
			if slices.Contains(arg, "clone") {
				c.cloneArgs = append(c.cloneArgs, append([]string(nil), arg...))
				bare := arg[len(arg)-1]
				if err := os.MkdirAll(bare, 0755); err != nil {
					return &mockCmd{runFn: func() error { return err }}
				}
				return &mockCmd{}
			}
			if slices.Contains(arg, "worktree") && slices.Contains(arg, "add") {
				c.worktreeAdd = append(c.worktreeAdd, append([]string(nil), arg...))
				wt := arg[len(arg)-1]
				if err := os.MkdirAll(wt, 0755); err != nil {
					return &mockCmd{runFn: func() error { return err }}
				}
				if err := os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: ../.bare/worktrees/main\n"), 0644); err != nil {
					return &mockCmd{runFn: func() error { return err }}
				}
				return &mockCmd{}
			}
		}
		return saved(ctx, name, arg...)
	})
	return c
}

// gitCloneCapture records the git clone/worktree argv from stubGitClone. It
// also carries the fake `symbolic-ref HEAD` output/error the default-branch
// probe must see (tune via symRefOut/symRefErr between stub and call).
//
// symRefOut defaults to "refs/heads/main\n" (the common case); set symRefErr
// to exercise the detached-HEAD fallback.

type gitCloneCapture struct {
	cloneArgs    []string
	worktreeArgs []string
	symRefArgs   []string
	configArgs   []string
	updateRefs   []string
	upstreamArgs []string
	symRefOut    string
	symRefErr    error
}

// stubGitClone stubs the git seam for gitCloneWorktree tests: captures the
// clone/worktree argv into a struct (closure-safe: the stub outlives the
// helper call) and lets the test inject failures via non-nil errors. Non-git
// commands fall through to the real seam.
