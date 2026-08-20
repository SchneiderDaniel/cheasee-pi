package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
)

// ──────────────────────────────────────────────
// Mock: Authenticator
// ──────────────────────────────────────────────

// MockGitHubUser is the deterministic login the mock Authenticator.User stub
// returns by default — both init entry points share it, keeping the
// auto-init byte-identity contract deterministic.
const MockGitHubUser = "octocat"

type mockAuthenticator struct {
	requestCodeFunc func(ctx context.Context, scopes []string) (*device.CodeResponse, error)
	waitFunc        func(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error)
	userFunc        func(ctx context.Context, token string) (string, error)
}

func (m *mockAuthenticator) RequestCode(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
	if m.requestCodeFunc != nil {
		return m.requestCodeFunc(ctx, scopes)
	}
	return &device.CodeResponse{
		UserCode:        "ABCD-1234",
		DeviceCode:      "test-device-code",
		VerificationURI: "https://github.com/login/device",
		Interval:        5,
		ExpiresIn:       900,
	}, nil
}

func (m *mockAuthenticator) Wait(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error) {
	if m.waitFunc != nil {
		return m.waitFunc(ctx, code)
	}
	return &api.AccessToken{Token: FakeGitHubToken}, nil
}

func (m *mockAuthenticator) User(ctx context.Context, token string) (string, error) {
	if m.userFunc != nil {
		return m.userFunc(ctx, token)
	}
	return MockGitHubUser, nil
}

// ──────────────────────────────────────────────
// Mock: ConfirmFn
// ──────────────────────────────────────────────

// mockConfirmFn returns a confirm function that returns the given result.
// mockConfirmFn creates a mock confirm function.
// If exceptions are provided, any question whose title contains one of the
// exception substrings returns !result instead of result.
func mockConfirmFn(result bool, err error, exceptions ...string) func(string) (bool, error) {
	return func(title string) (bool, error) {
		for _, exc := range exceptions {
			if strings.Contains(title, exc) {
				return !result, err
			}
		}
		return result, err
	}
}

// ──────────────────────────────────────────────
// Mock: InputFn
// ──────────────────────────────────────────────

// mockInputFn returns an input function that returns the given result.
func mockInputFn(result string, err error) func(title, placeholder string) (string, error) {
	return func(title, placeholder string) (string, error) {
		return result, err
	}
}

// ──────────────────────────────────────────────
// Custom skill repositories (init Phase 6b) flow helper
// ──────────────────────────────────────────────

// skillRepoFlowDeps builds the full interactive init deps with a queue-based
// prompt mock: the first InputFn call answers the repo URL prompt, remaining
// inputs feed the skill-repo loop; the first confirm answers "Add a custom
// skill repository?", a false terminates the loop, and the API-key confirm
// falls through to the exhausted-queue default (false → skip).
func skillRepoFlowDeps(t *testing.T, workdir string, confirms []bool, inputs []string) InitDeps {
	t.Helper()
	confirm, input := mockQueuePrompt(t, confirms, inputs)
	return initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		d.ConfirmFn = confirm
		d.InputFn = input
	})
}

// ──────────────────────────────────────────────
// Mock: queue-based prompt (successive ConfirmFn/InputFn results)
// ──────────────────────────────────────────────

// mockQueuePrompt returns a confirm/input pair that yield successive results
// from the pre-filled queues — the skill-repo prompt loop alternates
// confirm/input (yes → spec → yes → spec → no), and each queue is exhausted
// to a safe default (false / "") so a loop that prompts one extra time
// terminates instead of hanging. Used by the runInitSkillRepos and full-flow
// tests.
func mockQueuePrompt(t *testing.T, confirms []bool, inputs []string) (func(string) (bool, error), func(string, string) (string, error)) {
	t.Helper()
	q := &queuePrompt{confirms: confirms, inputs: inputs}
	return q.confirm, q.input
}

type queuePrompt struct {
	confirms []bool
	inputs   []string
}

func (q *queuePrompt) confirm(string) (bool, error) {
	if len(q.confirms) == 0 {
		return false, nil
	}
	next := q.confirms[0]
	q.confirms = q.confirms[1:]
	return next, nil
}

func (q *queuePrompt) input(string, string) (string, error) {
	if len(q.inputs) == 0 {
		return "", nil
	}
	next := q.inputs[0]
	q.inputs = q.inputs[1:]
	return next, nil
}

// ──────────────────────────────────────────────
// Compile-time interface checks
// ──────────────────────────────────────────────

var (
	_ Authenticator = (*mockAuthenticator)(nil)
)

// ──────────────────────────────────────────────
// Mock: cmdIface
// ──────────────────────────────────────────────

type mockCmd struct {
	outputFn   func() ([]byte, error)
	combinedFn func() ([]byte, error)
	runFn      func() error
	// Captured Set* config, for callers that configure the command
	dir    string
	env    []string
	stdout interface{ Write([]byte) (int, error) }
	stderr interface{ Write([]byte) (int, error) }
}

func (m *mockCmd) Output() ([]byte, error) {
	if m.outputFn != nil {
		return m.outputFn()
	}
	return nil, nil
}

func (m *mockCmd) CombinedOutput() ([]byte, error) {
	if m.combinedFn != nil {
		return m.combinedFn()
	}
	return nil, nil
}

func (m *mockCmd) Run() error {
	if m.runFn != nil {
		return m.runFn()
	}
	return nil
}

func (m *mockCmd) SetDir(d string)       { m.dir = d }
func (m *mockCmd) SetEnv(e []string)     { m.env = e }
func (m *mockCmd) SetStdout(w io.Writer) { m.stdout = w }
func (m *mockCmd) SetStderr(w io.Writer) { m.stderr = w }

// ──────────────────────────────────────────────
// Seam stubs (docker/git CLI tests)
// ──────────────────────────────────────────────

// stubRunCommandContext replaces the runCommandContext seam for the duration
// of the test. Serialized (no t.Parallel) — package-var swap is race-free
// only under serial execution.
func stubRunCommandContext(t *testing.T, fn func(context.Context, string, ...string) runner) {
	t.Helper()
	saved := runCommandContext
	runCommandContext = fn
	t.Cleanup(func() { runCommandContext = saved })
}

// stubExecCommand replaces the execCommand seam for the duration of the test.
func stubExecCommand(t *testing.T, fn func(string, ...string) cmdIface) {
	t.Helper()
	saved := execCommand
	execCommand = fn
	t.Cleanup(func() { execCommand = saved })
}

// stubLookPath replaces the lookPath seam for the duration of the test.
func stubLookPath(t *testing.T, fn func(string) (string, error)) {
	t.Helper()
	saved := lookPath
	lookPath = fn
	t.Cleanup(func() { lookPath = saved })
}

// stubDockerCheck stubs the docker seams. daemonErr, when non-nil, makes
// `docker info` fail; version is the docker version output (versionErr wins
// over version when set).
func stubDockerCheck(t *testing.T, daemonErr error, version string, versionErr error) {
	t.Helper()
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	stubRunCommandContext(t, func(_ context.Context, _ string, arg ...string) runner {
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
	if err := NewSettingsScaffold().Scaffold(context.Background(), workdir, vals); err != nil {
		t.Fatalf("Scaffold failed: %v", err)
	}
	return workdir
}

// RenderEnv renders docker/.env from vals and returns the file content.
func RenderEnv(t *testing.T, vals EnvValues) string {
	t.Helper()
	dest := filepath.Join(t.TempDir(), "docker", ".env")
	if err := NewEnvRenderer().Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render failed: %v", err)
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	return string(data)
}

// ──────────────────────────────────────────────
// Auth/config seeding + package-var mutation
// ──────────────────────────────────────────────

// defaultMocks returns a set of working mock implementations for the genuine
// seam ports (network/external-service boundaries). In-process adapters
// (probe, extract, env, scaffold, remover, uid, git identity) are real.
func defaultMocks() InitPorts {
	return InitPorts{
		Auth: &mockAuthenticator{},
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

// marshalAuth JSON-marshals auth, failing the test on error.
func marshalAuth(t *testing.T, auth *Auth) []byte {
	t.Helper()
	data, err := json.Marshal(auth)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}
	return data
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
