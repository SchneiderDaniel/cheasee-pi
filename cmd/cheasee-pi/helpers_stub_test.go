package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func init() {
	// The upstream-commit probe (CHEASEE_COMMIT cache-bust, issue #2054) must
	// never touch the network in unit tests: default it to an empty resolution.
	// Its real implementation is exercised by TestResolveCheaseeCommit_* with a
	// stubbed runCommandContext.
	resolveCheaseeCommit = func(context.Context, string) (string, error) { return "", nil }
}

func stubGitClone(t *testing.T, cloneErr, worktreeErr error) *gitCloneCapture {
	t.Helper()
	c := &gitCloneCapture{symRefOut: "refs/heads/main\n"}
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "git" && slices.Contains(arg, "clone") {
			c.cloneArgs = append(append([]string(nil), name), arg...)
			// Materialize the bare dir (git would leave a partial .bare on a
			// failed clone too) so cleanup assertions are exercised.
			if err := os.MkdirAll(arg[len(arg)-1], 0755); err != nil {
				return &mockCmd{runFn: func() error { return err }}
			}
			if cloneErr != nil {
				return &mockCmd{combinedFn: func() ([]byte, error) { return []byte("fatal: remote error"), cloneErr }}
			}
			return &mockCmd{}
		}
		if name == "git" && slices.Contains(arg, "symbolic-ref") {
			c.symRefArgs = append(append([]string(nil), name), arg...)
			return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(c.symRefOut), c.symRefErr }}
		}
		if name == "git" && slices.Contains(arg, "worktree") {
			c.worktreeArgs = append(append([]string(nil), name), arg...)
			if worktreeErr != nil {
				return &mockCmd{combinedFn: func() ([]byte, error) { return []byte("fatal: invalid reference"), worktreeErr }}
			}
			return &mockCmd{}
		}
		// Upstream wiring (wireUpstream): config fetch refspec, local
		// update-ref of the remote-tracking ref, branch --set-upstream-to.
		if name == "git" && slices.Contains(arg, "config") && slices.Contains(arg, "remote.origin.fetch") {
			c.configArgs = append(append([]string(nil), name), arg...)
			return &mockCmd{}
		}
		if name == "git" && slices.Contains(arg, "update-ref") {
			c.updateRefs = append(append([]string(nil), name), arg...)
			return &mockCmd{}
		}
		if name == "git" && slices.Contains(arg, "--set-upstream-to") {
			c.upstreamArgs = append(append([]string(nil), name), arg...)
			return &mockCmd{}
		}
		return saved(ctx, name, arg...)
	})
	return c
}

// runGit execs the real git binary, failing the test on error.

func runGit(t *testing.T, args ...string) []byte {
	t.Helper()
	if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return nil
}

// gitRemoteFixture builds a real git repo with one commit on the given
// default branch, usable as a clone source for the adapter tests.

func gitRemoteFixture(t *testing.T, branch string) string {
	t.Helper()
	src := t.TempDir()
	runGit(t, "-C", src, "init", "-q")
	// Force the default branch explicitly (host init.defaultBranch config
	// may otherwise pick main or master regardless of the fixture intent).
	runGit(t, "-C", src, "symbolic-ref", "HEAD", "refs/heads/"+branch)
	runGit(t, "-C", src, "config", "user.email", "t@t.t")
	runGit(t, "-C", src, "config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(src, "README.md"), []byte("fixture\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGit(t, "-C", src, "add", "README.md")
	runGit(t, "-C", src, "commit", "-q", "-m", "init")
	return src
}

// cloneWorktreeLayout builds the init-clone layout (bare clone + default
// branch probe + worktree add <branch>) exactly as gitCloneWorktree does,
// including the wireUpstream remote-tracking setup (refspec, tracking ref,
// upstream binding).

func cloneWorktreeLayout(t *testing.T, src, parent, workdir string) string {
	t.Helper()
	bareDir := filepath.Join(parent, ".bare")
	runGit(t, "clone", "--bare", "-q", src, bareDir)
	out, err := exec.Command("git", "--git-dir", bareDir, "symbolic-ref", "HEAD").CombinedOutput()
	if err != nil {
		t.Fatalf("symbolic-ref HEAD: %v\n%s", err, out)
	}
	branch := strings.TrimPrefix(strings.TrimSpace(string(out)), "refs/heads/")
	runGit(t, "--git-dir", bareDir, "worktree", "add", workdir, branch)
	// Mirror wireUpstream so the layout tracks origin like the real init.
	runGit(t, "--git-dir", bareDir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
	runGit(t, "--git-dir", bareDir, "update-ref", "refs/remotes/origin/"+branch, branch)
	runGit(t, "--git-dir", bareDir, "branch", "--set-upstream-to", "origin/"+branch, branch)
	return bareDir
}

// ──────────────────────────────────────────────
// Docker-backed e2e harness seams (AC1/AC2/AC3/AC4)
// ──────────────────────────────────────────────

// requireDockerDaemon skips (never fails) when the host has no usable Docker
// daemon or compose plugin — the repo's established probe-then-t.Skip shape
// (`t.Skipf("git binary not available")` et al.). The probe lives in exactly
// one helper so a daemon-less runner skips every daemon-backed test with the
// same reason instead of failing each one on a different command.

func requireDockerDaemon(t *testing.T) {
	t.Helper()
	if _, err := lookPath("docker"); err != nil {
		t.Skipf("docker binary not available: %v", err)
	}
	if err := runCommandContext(context.Background(), "docker", "info").Run(); err != nil {
		t.Skipf("docker daemon not available: %v", err)
	}
	if err := runCommandContext(context.Background(), "docker", "compose", "version").Run(); err != nil {
		t.Skipf("docker compose plugin not available: %v", err)
	}
}

// composeEnvForTest installs the process env `applyComposeEnv` injects before
// a compose up — the env contract the harness must reproduce verbatim so a
// rendered compose file matches what `cheasee-pi start` would hand Compose.
// Names come from the same identity.go functions the production path uses, so
// a naming change fails loudly here rather than silently diverging. Ports are
// pinned to the compose defaults (the call sites that care set their own).
