package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
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

// promptCall records one InputFn invocation (title + placeholder) for the
// capturing-input mock below.
type promptCall struct {
	title       string
	placeholder string
}

// captureInputFn returns an input function that records every call's
// title+placeholder pair and yields the given results in order (queue
// exhaustion → "", nil). Used to lock the init prompt strings, which the
// other mocks ignore.
func captureInputFn(t *testing.T, results ...string) (func(string, string) (string, error), *[]promptCall) {
	t.Helper()
	calls := &[]promptCall{}
	i := 0
	return func(title, placeholder string) (string, error) {
		*calls = append(*calls, promptCall{title: title, placeholder: placeholder})
		if i >= len(results) {
			return "", nil
		}
		next := results[i]
		i++
		return next, nil
	}, calls
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
// Mock: ModelCatalog
// ──────────────────────────────────────────────

// mockModelCatalog is a fixed-list ModelCatalog stub. The zero value returns
// (nil, nil), which modelsFor/modelChoice treat as "no live list" → the
// KnownModels seed (the offline path).
type mockModelCatalog struct {
	models []string
	err    error
}

func (m *mockModelCatalog) Models(ctx context.Context, provider string) ([]string, error) {
	return m.models, m.err
}

// countingModelCatalog is a fixed-list ModelCatalog stub that counts
// consultations — the single-lookup regression tests assert exactly one
// consultation per provider invocation (the pre-audit code consulted twice,
// doubling the fetch/retry loop on a failing pi.dev request).
type countingModelCatalog struct {
	models []string
	err    error
	calls  int
}

func (c *countingModelCatalog) Models(ctx context.Context, provider string) ([]string, error) {
	c.calls++
	return c.models, c.err
}

// slowModelCatalog is a stub whose consultation sleeps before failing — the
// call-site timeout regression asserts a stalled catalog delays auth/init by
// ONE consultation, not two.
type slowModelCatalog struct {
	delay time.Duration
	err   error
	calls int
}

func (c *slowModelCatalog) Models(ctx context.Context, provider string) ([]string, error) {
	c.calls++
	time.Sleep(c.delay)
	return nil, c.err
}

// stubModelCatalog replaces the newModelCatalog seam (newInitDeps precedent)
// for the duration of the test, so auth/init flows run without a real fetch.
func stubModelCatalog(t *testing.T, models []string, err error) {
	t.Helper()
	saved := newModelCatalog
	newModelCatalog = func() ModelCatalog { return &mockModelCatalog{models: models, err: err} }
	t.Cleanup(func() { newModelCatalog = saved })
}

// stubPromptProvider replaces the provider-picker seam for the duration of
// the test (huh TTY calls hang tests, same reason as runCommandContext).
func stubPromptProvider(t *testing.T, fn func() (string, error)) {
	t.Helper()
	saved := promptProvider
	promptProvider = fn
	t.Cleanup(func() { promptProvider = saved })
}

// stubPromptAPIKey replaces the API-key prompt seam for the duration of the
// test.
func stubPromptAPIKey(t *testing.T, fn func(string) (string, error)) {
	t.Helper()
	saved := promptAPIKeyForProvider
	promptAPIKeyForProvider = fn
	t.Cleanup(func() { promptAPIKeyForProvider = saved })
}

// stubPromptModel replaces the model-picker seam for the duration of the test.
func stubPromptModel(t *testing.T, fn func(string, []string) (string, error)) {
	t.Helper()
	saved := promptModel
	promptModel = fn
	t.Cleanup(func() { promptModel = saved })
}

// withAuthAddFlags pins the package-level auth add flags (workdir + --no-input)
// for the duration of the test, mirroring withAuthListWorkdir.
func withAuthAddFlags(t *testing.T, workdir string, noInput bool) {
	t.Helper()
	savedWorkdir, savedNoInput := authAddWorkdir, authAddNoInput
	authAddWorkdir, authAddNoInput = workdir, noInput
	t.Cleanup(func() { authAddWorkdir, authAddNoInput = savedWorkdir, savedNoInput })
}

// ──────────────────────────────────────────────
// Catalog fixtures (remoteModelCatalog adapter tests)
// ──────────────────────────────────────────────

// catalogPlainMap is a canned plain-object-map catalog response (the live
// endpoint's shape), keys deliberately unsorted to prove Models() returns
// deterministic lexicographic order.
const catalogPlainMap = `{
  "zebra-model": {"id": "zebra-model", "name": "Zebra"},
  "alpha-model": {"id": "alpha-model", "name": "Alpha"},
  "mike-model":  {"id": "mike-model",  "name": "Mike"}
}`

// catalogSorted is the lexicographically sorted id set of catalogPlainMap.
var catalogSorted = []string{"alpha-model", "mike-model", "zebra-model"}

// catalogServer is the httptest fixture for the remoteModelCatalog adapter
// tests: wraps every request with a counter + last-header/URL capture, then
// delegates to the per-test handler (nil → serve catalogPlainMap with 200).
type catalogServer struct {
	ts      *httptest.Server
	reqs    atomic.Int32
	lastHdr http.Header
	lastURL string
}

func newCatalogServer(t *testing.T, handler http.HandlerFunc) *catalogServer {
	t.Helper()
	s := &catalogServer{}
	if handler == nil {
		handler = func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, catalogPlainMap)
		}
	}
	var mu sync.Mutex
	s.ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.reqs.Add(1)
		mu.Lock()
		s.lastHdr = r.Header.Clone()
		s.lastURL = r.URL.String()
		mu.Unlock()
		handler(w, r)
	}))
	t.Cleanup(s.ts.Close)
	return s
}

// cacheModelsDir resolves the per-provider cache dir the adapter writes to
// under the test's XDG_CACHE_HOME (version-keyed, mirroring CacheDir).
func cacheModelsDir(t *testing.T) string {
	t.Helper()
	return filepath.Join(os.Getenv("XDG_CACHE_HOME"), "cheasee-pi", cliVersionKey, "models")
}

// newTestCatalog builds the adapter against a fixture server with an explicit
// attempt timeout (tests never rely on the 4s production default).
func newTestCatalog(srv *catalogServer, attemptTimeout time.Duration) *remoteModelCatalog {
	return &remoteModelCatalog{
		httpClient:     srv.ts.Client(),
		baseURL:        srv.ts.URL,
		attemptTimeout: attemptTimeout,
	}
}

// newAuthAddWorkdir scaffolds a cheasee-pi workspace (the marker file the
// SettingsWriter keys its missing-file policy on) so auth add's workspace
// half exercises all three settings files.
func newAuthAddWorkdir(t *testing.T) string {
	t.Helper()
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"seed","defaultModel":"seed-model"}`)
	return workdir
}

// writeStaleCache seeds a per-provider cache file with an old checkedAt and
// the given models body — the refetch/revalidation fixtures.
func writeStaleCache(t *testing.T, provider, body string) {
	t.Helper()
	if err := os.MkdirAll(cacheModelsDir(t), 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(cacheModelsDir(t), url.PathEscape(provider)+".json")
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
}

// ──────────────────────────────────────────────
// Compile-time interface checks
// ──────────────────────────────────────────────

var (
	_ Authenticator = (*mockAuthenticator)(nil)
	_ ModelCatalog  = (*mockModelCatalog)(nil)
)

// ──────────────────────────────────────────────
// Mock: runner (single exec seam)
// ──────────────────────────────────────────────

type mockCmd struct {
	outputFn   func() ([]byte, error)
	combinedFn func() ([]byte, error)
	runFn      func() error
	// Captured Set* config, for callers that configure the command
	dir    string
	env    []string
	stdin  io.Reader
	stdout interface{ Write([]byte) (int, error) }
	stderr interface{ Write([]byte) (int, error) }
}

var _ runner = (*mockCmd)(nil)

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
func (m *mockCmd) SetStdin(r io.Reader)  { m.stdin = r }
func (m *mockCmd) SetStdout(w io.Writer) { m.stdout = w }
func (m *mockCmd) SetStderr(w io.Writer) { m.stderr = w }

// ──────────────────────────────────────────────
// Seam stubs (docker/git CLI tests)
// ──────────────────────────────────────────────

// stubRunCommandContext replaces the runCommandContext seam — the ONLY exec
// seam — for the duration of the test. Serialized (no t.Parallel) — package-var
// swap is race-free only under serial execution.
func stubRunCommandContext(t *testing.T, fn func(context.Context, string, ...string) runner) {
	t.Helper()
	saved := runCommandContext
	runCommandContext = fn
	t.Cleanup(func() { runCommandContext = saved })
}

// stubLookPath replaces the lookPath seam for the duration of the test.
func stubLookPath(t *testing.T, fn func(string) (string, error)) {
	t.Helper()
	saved := lookPath
	lookPath = fn
	t.Cleanup(func() { lookPath = saved })
}

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
func composeEnvForTest(t *testing.T, root string) []string {
	t.Helper()
	env := []string{
		"WORKSPACE_HOST_PATH=" + root,
		"WORKSPACE_BARE_PATH=" + filepath.Join(filepath.Dir(root), ".bare"),
		"CHEASEEPI_CONTAINER=" + containerName(root),
		"CODEFLOW_CONTAINER=" + codeflowContainerName(root),
		"PI_UI_CONTAINER=" + uiContainerName(root),
		"COMPOSE_PROJECT_NAME=" + composeProjectName(root),
		"PI_UI_PORT=9500",
		"CODEFLOW_PORT=8470",
	}
	for _, kv := range env {
		key, value, _ := strings.Cut(kv, "=")
		t.Setenv(key, value)
	}
	return env
}

// ──────────────────────────────────────────────
// Extracted seam-factory tests
// ──────────────────────────────────────────────

func TestGitRootMock(t *testing.T) {
	root := t.TempDir()
	type call struct {
		name string
		arg  []string
	}
	var passCalls []call
	sentinel := &mockCmd{outputFn: func() ([]byte, error) { return []byte("sentinel"), nil }}
	seam := gitRootMock(root, func(_ context.Context, name string, arg ...string) runner {
		passCalls = append(passCalls, call{name, append([]string(nil), arg...)})
		return sentinel
	})
	ctx := context.Background()
	out := func(name string, arg ...string) string {
		b, _ := seam(ctx, name, arg...).Output()
		return string(b)
	}

	if got := out("git", "rev-parse", "--is-inside-work-tree"); got != "true" {
		t.Errorf("--is-inside-work-tree = %q, want true", got)
	}
	if got := out("git", "-C", root, "rev-parse", "--show-prefix"); got != "" {
		t.Errorf("--show-prefix at toplevel = %q, want %q", got, "")
	}
	if got := out("git", "-C", filepath.Join(root, "sub"), "rev-parse", "--show-prefix"); got != "sub/" {
		t.Errorf("--show-prefix sub = %q, want sub/", got)
	}
	if got := out("git", "-C", filepath.Join(root, "sub", "deep"), "rev-parse", "--show-prefix"); got != "sub/deep/" {
		t.Errorf("--show-prefix deep = %q, want sub/deep/", got)
	}
	// No -C: filepath.Rel errors on the empty target, so git reports "" too.
	if got := out("git", "rev-parse", "--show-prefix"); got != "" {
		t.Errorf("--show-prefix without -C = %q, want %q", got, "")
	}
	if got := out("git", "-C", filepath.Join(root, "first"), "-C", filepath.Join(root, "sub"), "rev-parse", "--show-prefix"); got != "sub/" {
		t.Errorf("duplicate -C must take the last, got %q, want sub/", got)
	}
	if got := out("git", "rev-parse", "--show-toplevel"); got != root {
		t.Errorf("unknown git arg = %q, want root %q", got, root)
	}
	// Documents the filepath.Rel dependency: outside root yields "../<sibling>/".
	if got := out("git", "-C", filepath.Join(filepath.Dir(root), "sibling"), "rev-parse", "--show-prefix"); got != "../sibling/" {
		t.Errorf("--show-prefix outside root = %q, want ../sibling/", got)
	}

	if got := seam(ctx, "git", "config", "--get", "remote.origin.url"); got != sentinel {
		t.Errorf("git config must return the passthrough runner")
	}
	if len(passCalls) != 1 || passCalls[0].name != "git" || !slices.Equal(passCalls[0].arg, []string{"config", "--get", "remote.origin.url"}) {
		t.Errorf("git config passthrough = %+v, want one identical call", passCalls)
	}

	if got := seam(ctx, "docker", "version"); got != sentinel {
		t.Errorf("non-git must return the passthrough runner")
	}
	if len(passCalls) != 2 || passCalls[1].name != "docker" || !slices.Equal(passCalls[1].arg, []string{"version"}) {
		t.Errorf("non-git passthrough = %+v, want one identical call", passCalls)
	}
}

func TestNewWorkspace(t *testing.T) {
	parent, workdir := newWorkspace(t)
	if workdir != filepath.Join(parent, "ws") {
		t.Errorf("workdir = %q, want %q", workdir, filepath.Join(parent, "ws"))
	}
	for _, dir := range []string{parent, workdir} {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			t.Errorf("%q must exist as a dir: %v", dir, err)
		}
	}
	// Empty: no settings file, no sibling .bare — deliberately NOT mkWorkspace.
	for _, p := range []string{filepath.Join(workdir, "cheasee-settings.json"), filepath.Join(parent, ".bare")} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%q must not exist, got err=%v", p, err)
		}
	}
	if parent2, _ := newWorkspace(t); parent2 == parent {
		t.Error("two calls must return disjoint roots")
	}
}

func TestStubInitFlow(t *testing.T) {
	c := stubInitFlow(t)
	if c == nil {
		t.Fatal("stubInitFlow must return a clone capture")
	}
	ctx := context.Background()

	if out, err := runCommandContext(ctx, "docker", "version").Output(); err != nil || string(out) != "24.0.9" {
		t.Errorf("docker version = %q, %v; want 24.0.9", out, err)
	}
	if err := runCommandContext(ctx, "docker", "info").Run(); err != nil {
		t.Errorf("docker info must succeed: %v", err)
	}

	// Detached worktree add keeps the target last, matching the real argv the
	// stub materializes (the branch-form bare-HEAD probe fails against the fake
	// .bare, so the init flow lands here).
	parent := t.TempDir()
	bare := filepath.Join(parent, ".bare")
	if err := runCommandContext(ctx, "git", "clone", "--bare", "https://example.com/o/r", bare).Run(); err != nil {
		t.Fatalf("stubbed git clone: %v", err)
	}
	if len(c.cloneArgs) != 1 || c.cloneArgs[0][len(c.cloneArgs[0])-1] != bare {
		t.Errorf("clone argv not captured: %v", c.cloneArgs)
	}
	if _, err := os.Stat(bare); err != nil {
		t.Errorf("bare dir must be materialized: %v", err)
	}

	wt := filepath.Join(parent, "ws")
	if err := runCommandContext(ctx, "git", "--git-dir", bare, "worktree", "add", "--detach", wt).Run(); err != nil {
		t.Fatalf("stubbed worktree add: %v", err)
	}
	if len(c.worktreeAdd) != 1 {
		t.Errorf("worktree argv not captured: %v", c.worktreeAdd)
	}
	if b, err := os.ReadFile(filepath.Join(wt, ".git")); err != nil || string(b) != "gitdir: ../.bare/worktrees/main\n" {
		t.Errorf("worktree .git = %q, %v", b, err)
	}

	// Non-docker/non-git falls through to the real seam: the hermetic identity
	// read still resolves.
	if out, err := runCommandContext(ctx, "git", "config", "--global", "user.name").Output(); err != nil || strings.TrimSpace(string(out)) != "Test User" {
		t.Errorf("git identity read = %q, %v; want Test User", out, err)
	}
}
