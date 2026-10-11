package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
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
