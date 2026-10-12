package main

import (
	"context"
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

// runSeam is the runCommandContext seam shape the mock factories wrap.

type runSeam func(context.Context, string, ...string) runner

// gitRootMock answers the git worktree probes the up/init flows depend on:
// `rev-parse` resolves to root, `--is-inside-work-tree` is true, `--show-prefix`
// mirrors git's trailing-slash / ""-at-toplevel output, and `git config`
// passes through so the fixture `.bare` identity read still reaches the real
// binary. Non-git names fall through to passthrough too, so the factory can be
// the outer seam when a caller has no docker dispatch to compose with.

func gitRootMock(root string, passthrough runSeam) runSeam {
	return func(ctx context.Context, name string, arg ...string) runner {
		if name != "git" {
			return passthrough(ctx, name, arg...)
		}
		if slices.Contains(arg, "--is-inside-work-tree") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("true"), nil }}
		}
		if slices.Contains(arg, "--show-prefix") {
			// Mirror git: trailing slash when non-empty, "" at toplevel.
			workdir := ""
			for i, a := range arg {
				if a == "-C" && i+1 < len(arg) {
					workdir = arg[i+1]
				}
			}
			prefix := ""
			if rel, err := filepath.Rel(root, workdir); err == nil && rel != "." {
				prefix = filepath.ToSlash(rel) + "/"
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(prefix), nil }}
		}
		if slices.Contains(arg, "config") {
			// Real .bare config read for identity derivation (fixture remotes).
			return passthrough(ctx, name, arg...)
		}
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte(root), nil }}
	}
}

// exitStatusError fabricates a real *exec.ExitError with the given exit code
// by running a throwaway `sh -c "exit N"` child: a hand-constructed
// os.ProcessState always reports exit 0 (its status field is unexported), so
// a real child process is the only way to get a true exit status for the
// adapter's exit-code translation tests. sh exists on every platform this
// CLI targets (Linux/macOS — the docker daemon requirement).

func exitStatusError(code int) error {
	cmd := exec.Command("sh", "-c", fmt.Sprintf("exit %d", code))
	if err := cmd.Run(); err == nil {
		panic("sh -c exit N must fail")
	} else {
		return err
	}
}

// stubDockerCheck stubs the docker seams. daemonErr, when non-nil, makes
// `docker info` fail; version is the docker version output (versionErr wins
// over version when set). Non-docker commands (git config identity reads,
// clone fall-throughs) stay on the real seam.

func stubDockerCheck(t *testing.T, daemonErr error, version string, versionErr error) {
	t.Helper()
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return saved(ctx, name, arg...)
		}
		if len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) {
				if versionErr != nil {
					return nil, versionErr
				}
				return []byte(version), nil
			}}
		}
		return &mockCmd{runFn: func() error { return daemonErr }}
	})
}

// newWorkspace returns a fresh parent dir holding an empty `ws` workdir — the
// folder shape the init/up flows require (init refuses a non-empty directory).
// Distinct from mkWorkspace, which additionally seeds cheasee-settings.json and
// the sibling `.bare`.

func newWorkspace(t *testing.T) (parent, workdir string) {
	t.Helper()
	parent = t.TempDir()
	workdir = filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	return parent, workdir
}

// stubInitFlow installs the init-test preamble in the one order that keeps the
// seams chained: hermetic config home + git identity, the docker check, then
// the clone git stub (whose passthrough must be the docker stub, not the real
// seam). Returns the clone/worktree capture for the caller's assertions.

func stubInitFlow(t *testing.T) *cloneCapture {
	t.Helper()
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	return stubInitGit(t)
}

// ──────────────────────────────────────────────
// Renderer + scaffold helpers (package-main value types)
// ──────────────────────────────────────────────

// testGitIdentityConfig is the hermetic git identity used by init tests.

const testGitIdentityConfig = "[user]\n\tname = Test User\n\temail = test@example.com\n"

// ScaffoldSettings renders the embedded settings template into a fresh
// workdir and returns the workdir.

func ScaffoldSettings(t *testing.T, vals TemplateSettingsValues) string {
	t.Helper()
	workdir := t.TempDir()
	if err := (&templateSettingsRenderer{
		source:       embeddedFS,
		templatePath: "embedded/pi/settings.json",
		dest:         func(workdir string) string { return filepath.Join(workdir, ".pi", "settings.json") },
	}).Scaffold(context.Background(), workdir, vals); err != nil {
		t.Fatalf("Scaffold failed: %v", err)
	}
	return workdir
}

// ──────────────────────────────────────────────
// Auth/config seeding + package-var mutation
// ──────────────────────────────────────────────

// defaultMocks returns a set of working mock implementations for the genuine
// seam ports (network/external-service boundaries). In-process adapters
// (extract, env, scaffold, remover, git identity) are real.

func defaultMocks() InitPorts {
	return InitPorts{
		Auth:    &mockAuthenticator{},
		Catalog: &mockModelCatalog{}, // no live list → seed fallback
	}
}

// seedAuth writes auth.json providers into the current config home. Call
// testutil.RedirectConfigHome or pinPassthroughEnv first.

func seedAuth(t *testing.T, providers map[string]string) {
	t.Helper()
	cfg := &fileRepository{}
	for name, key := range providers {
		if err := cfg.AddProvider(context.Background(), name, key); err != nil {
			t.Fatalf("seed auth.json: %v", err)
		}
	}
}

// withAuthListWorkdir sets the package-level auth list workdir for the test duration.
