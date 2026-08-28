package main

import (
	"bytes"
	"context"
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunInitAuth_Success(t *testing.T) {
	auth := &mockAuthenticator{}
	token, user, err := runInitAuth(context.Background(), auth)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != FakeGitHubToken {
		t.Errorf("expected %q, got %q", FakeGitHubToken, token)
	}
	if user != MockGitHubUser {
		t.Errorf("expected resolved user %q, got %q", MockGitHubUser, user)
	}
}

func TestRunInitAuth_RequestsProjectScope(t *testing.T) {
	var got []string
	auth := &mockAuthenticator{
		requestCodeFunc: func(_ context.Context, scopes []string) (*device.CodeResponse, error) {
			got = scopes
			return &device.CodeResponse{UserCode: "ABCD-1234", VerificationURI: "https://github.com/login/device"}, nil
		},
	}
	if _, _, err := runInitAuth(context.Background(), auth); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{"repo", "read:org", "project"} {
		found := false
		for _, s := range got {
			if s == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("requested scopes %v missing %q — supervisor project-board updates need it", got, want)
		}
	}
}

func TestRunInitAuth_UserLookupFailsOpen(t *testing.T) {
	// The GitHub login resolution is fail-open: OAuth already succeeded, so a
	// user lookup failure warns on stderr and yields an empty user — the
	// repository.user field simply stays empty ("when available").
	auth := &mockAuthenticator{
		userFunc: func(ctx context.Context, token string) (string, error) {
			return "", fmt.Errorf("GET /user failed")
		},
	}
	var token, user string
	var err error
	stderr := testutil.CaptureStderr(t, func() {
		token, user, err = runInitAuth(context.Background(), auth)
	})
	if err != nil {
		t.Fatalf("user lookup failure must not fail init: %v", err)
	}
	if token != FakeGitHubToken {
		t.Errorf("token must survive a failed lookup, got %q", token)
	}
	if user != "" {
		t.Errorf("fail-open user must be empty, got %q", user)
	}
	if !strings.Contains(stderr, "GET /user failed") {
		t.Errorf("stderr must warn about the lookup failure, got: %q", stderr)
	}
}

// ──────────────────────────────────────────────
// deviceFlowAuthenticator.User (adapter, HTTP seam)
// ──────────────────────────────────────────────

func TestDeviceFlowAuthenticator_User(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization = %q, want Bearer test-token", got)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"login":"octocat"}`)
	}))
	defer srv.Close()

	a := &deviceFlowAuthenticator{clientID: "test-client", httpClient: srv.Client(), userURL: srv.URL + "/user"}
	login, err := a.User(context.Background(), "test-token")
	if err != nil {
		t.Fatalf("User: %v", err)
	}
	if login != "octocat" {
		t.Errorf("login = %q, want octocat", login)
	}
}

func TestDeviceFlowAuthenticator_UserHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad credentials", http.StatusUnauthorized)
	}))
	defer srv.Close()

	a := &deviceFlowAuthenticator{clientID: "test-client", httpClient: srv.Client(), userURL: srv.URL + "/user"}
	if _, err := a.User(context.Background(), "test-token"); err == nil {
		t.Fatal("expected error for HTTP 401")
	}
}

func TestRunInitAuth_ExpiredToken(t *testing.T) {
	auth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return &device.CodeResponse{}, nil
		},
		waitFunc: func(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error) {
			return nil, fmt.Errorf("expired_token: device code expired")
		},
	}
	_, _, err := runInitAuth(context.Background(), auth)
	if err == nil {
		t.Fatal("expected error for expired token")
	}
	if !strings.Contains(err.Error(), "expired_token") {
		t.Errorf("error should mention expired_token: %v", err)
	}
}

func TestRunInitAuth_AccessDenied(t *testing.T) {
	auth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return &device.CodeResponse{}, nil
		},
		waitFunc: func(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error) {
			return nil, fmt.Errorf("access_denied: user cancelled")
		},
	}
	_, _, err := runInitAuth(context.Background(), auth)
	if err == nil {
		t.Fatal("expected error for access denied")
	}
	if !strings.Contains(err.Error(), "access_denied") {
		t.Errorf("error should mention access_denied: %v", err)
	}
}

func TestRunInitAuth_ContextCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	auth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return nil, ctx.Err()
		},
	}
	_, _, err := runInitAuth(ctx, auth)
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
}

func TestRunInitAuth_RequestCodeError(t *testing.T) {
	auth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return nil, fmt.Errorf("network error")
		},
	}
	_, _, err := runInitAuth(context.Background(), auth)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "network error") {
		t.Errorf("error should propagate: %v", err)
	}
}

func TestRunInit_FullFlow(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	clone := stubInitGit(t)

	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	err := runInit(context.Background(), initDepsWithRepoURL(t, workdir))
	if err != nil {
		t.Fatalf("full flow failed: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called after full flow")
	}
	// Clone phase artifacts: sibling bare repo + checked-out worktree leaf.
	if len(clone.cloneArgs) != 1 || len(clone.worktreeAdd) != 1 {
		t.Fatalf("expected one bare clone + one worktree add, got %d/%d", len(clone.cloneArgs), len(clone.worktreeAdd))
	}
	if _, err := os.Stat(filepath.Join(workdir, ".bare")); err != nil {
		t.Errorf("bare clone should have run (<workdir>/.bare missing): %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, "main", ".git")); err != nil {
		t.Errorf("worktree should be checked out at <workdir>/main (.git missing): %v", err)
	}
	// Dedicated settings scaffolded in the worktree leaf; pi's file absent.
	if _, err := os.Stat(filepath.Join(workdir, "main", "cheasee-settings.json")); err != nil {
		t.Errorf("cheasee-settings.json missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, "main", ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Errorf("init must not scaffold .pi/settings.json: %v", err)
	}
	// The scaffold persists what init already knows: the canonical repo URL
	// (shorthand normalized to https) and the resolved GitHub login, plus the
	// .pi skeleton dirs that pi needs to exist before it starts.
	raw := testutil.ReadCheaseeSettingsRaw(t, filepath.Join(workdir, "main"))
	repo, ok := raw["repository"].(map[string]any)
	if !ok {
		t.Fatal("expected repository section in cheasee-settings.json")
	}
	if repo["url"] != "https://github.com/owner/repo.git" {
		t.Errorf("repository.url = %v, want canonical https://github.com/owner/repo.git", repo["url"])
	}
	if repo["user"] != MockGitHubUser {
		t.Errorf("repository.user = %v, want %q", repo["user"], MockGitHubUser)
	}
	for _, dir := range piSkeletonDirs {
		if _, err := os.Stat(filepath.Join(workdir, "main", ".pi", dir)); err != nil {
			t.Errorf(".pi/%s missing after full flow: %v", dir, err)
		}
	}
	auth := loadAuthJSON(t)
	if auth.GitHubUser != MockGitHubUser {
		t.Errorf("auth.json github_user = %q, want %q", auth.GitHubUser, MockGitHubUser)
	}
	if auth.GitHubToken != FakeGitHubToken {
		t.Errorf("auth.json github_token = %q, want %q", auth.GitHubToken, FakeGitHubToken)
	}
}

func TestRunInit_NoGitHubFlag(t *testing.T) {
	// --no-github flag: API-key-only — no clone, no repo-URL prompt, no
	// .pi/settings.json; the dedicated cheasee-settings.json is scaffolded.
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
		d.Workdir = workdir
	}))
	if err != nil {
		t.Fatalf("legacy path should work: %v", err)
	}
	// Dedicated settings scaffolded; pi's own file is not.
	if _, err := os.Stat(filepath.Join(workdir, "cheasee-settings.json")); err != nil {
		t.Errorf("cheasee-settings.json should have been scaffolded: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Errorf("init must not scaffold .pi/settings.json: %v", err)
	}
	// No docker/ extraction into the workdir anymore, no clone.
	if _, err := os.Stat(filepath.Join(workdir, "docker")); !os.IsNotExist(err) {
		t.Errorf("docker/ must not be extracted into the workdir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, ".git")); !os.IsNotExist(err) {
		t.Errorf("--no-github must not clone or create .git: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called on legacy path")
	}
	auth := loadAuthJSON(t)
	if auth.APIKey != FakeAPIKey {
		t.Errorf("expected API key %q, got %q", FakeAPIKey, auth.APIKey)
	}
	if auth.RepoPath != workdir {
		t.Errorf("expected RepoPath %q, got %q", workdir, auth.RepoPath)
	}
	// Legacy path: the repo URL is never threaded, so no repository section —
	// but the .pi skeleton still exists (pi needs the dirs on both paths).
	raw := testutil.ReadCheaseeSettingsRaw(t, workdir)
	if _, ok := raw["repository"]; ok {
		t.Error("--no-github must not write a repository section")
	}
	for _, dir := range piSkeletonDirs {
		if _, err := os.Stat(filepath.Join(workdir, ".pi", dir)); err != nil {
			t.Errorf(".pi/%s missing on legacy path: %v", dir, err)
		}
	}
}

func TestRunInitLegacy_ReturnsAuth(t *testing.T) {
	// runInitLegacy is auth-only: returns *Auth, does NOT save/extract/render
	auth, err := runInitLegacy(context.Background(), &fileRepository{}, FakeAPIKey, "opencode-go")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if auth.APIKey != FakeAPIKey {
		t.Errorf("expected API key %q, got %q", FakeAPIKey, auth.APIKey)
	}
	if auth.RepoPath != "" {
		t.Errorf("expected empty RepoPath from runInitLegacy (orchestrator fills it), got %q", auth.RepoPath)
	}
	if auth.GitHubToken != "" {
		t.Errorf("expected empty GitHubToken, got %q", auth.GitHubToken)
	}
}

func TestRunInit_ContextCancelledMidFlow(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.RedirectConfigHome(t)
	ports := defaultMocks()

	// Override auth with one that respects cancelled context
	ports.Auth = &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return nil, ctx.Err()
		},
	}

	// Cancel right after docker check
	cancel()

	// Interactive with a stubbed repo-URL input and the docker check skipped
	// so the flow reaches the auth phase before erroring on the cancelled ctx.
	err := runInit(ctx, initDeps(t, func(d *InitDeps) {
		d.Ports = ports
		d.NoInput = false
		d.NoDockerCheck = true
		d.InputFn = mockInputFn("owner/repo", nil)
	}))
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
	if !strings.Contains(err.Error(), "GitHub authentication failed") {
		t.Errorf("error should wrap the auth failure, got: %v", err)
	}
	if authJSONExists(t) {
		t.Error("no partial auth.json must be saved when the flow fails")
	}
}

func TestRunReauth_RedoesAuthAndPreservesProviders(t *testing.T) {
	// Interactive reauth through runInit: docker check + probe routing +
	// device flow + user resolution + merge-safe patch + provider phase
	// (declined). No clone, no scaffold, no repo-URL input.
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	// Pre-seeded providers must survive the github patch (merge-safe).
	seedAuth(t, map[string]string{"openai": "key-openai", "anthropic": "key-anthropic"})

	workdir := t.TempDir()
	settings := `{"oauth":{"clientID":"app-123"},"docker":{"memory":"2G"},"gitIdentity":{"name":"N","email":"e@x"},"defaultProvider":"openai"}`
	testutil.WriteCheaseeSettingsFile(t, workdir, settings)

	// The default mock Authenticator already resolves the login (octocat),
	// so no HTTP seam is needed.
	var gitCalls int
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "git" {
			gitCalls++
		}
		return saved(ctx, name, arg...)
	})

	inputCalled := false
	var err error
	stderr := testutil.CaptureStderr(t, func() {
		err = runInit(context.Background(), initDeps(t, func(d *InitDeps) {
			d.Workdir = workdir
			d.Reauth = true
			d.NoInput = false
			d.InputFn = func(title, placeholder string) (string, error) {
				inputCalled = true
				return "", nil
			}
			d.ConfirmFn = mockConfirmFn(true, nil, "Configure API keys")
		}))
	})
	if err != nil {
		t.Fatalf("reauth through runInit failed: %v", err)
	}

	if gitCalls != 0 {
		t.Errorf("reauth must not clone (no git argv), got %d git calls", gitCalls)
	}
	if inputCalled {
		t.Error("reauth must not ask for a repo URL (InputFn must never be called)")
	}
	if _, statErr := os.Stat(filepath.Join(filepath.Dir(workdir), ".bare")); !os.IsNotExist(statErr) {
		t.Errorf("reauth must not create <parent>/.bare: %v", statErr)
	}

	auth := loadAuthJSON(t)
	if auth.GitHubToken != FakeGitHubToken {
		t.Errorf("expected fresh github_token %q, got %q", FakeGitHubToken, auth.GitHubToken)
	}
	if auth.GitHubUser != "octocat" {
		t.Errorf("expected github_user %q, got %q", "octocat", auth.GitHubUser)
	}
	if auth.RepoPath != workdir {
		t.Errorf("expected repo_path %q, got %q", workdir, auth.RepoPath)
	}
	providers, err := (&fileRepository{}).ListProviders(context.Background())
	if err != nil {
		t.Fatalf("ListProviders: %v", err)
	}
	if providers["openai"] != "key-openai" || providers["anthropic"] != "key-anthropic" {
		t.Errorf("pre-seeded providers must survive the patch, got %v", providers)
	}

	got, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	if string(got) != settings {
		t.Errorf("settings file must be preserved byte-identical (provider phase declined), got:\n%s", got)
	}

	if !strings.Contains(stderr, "✓ GitHub credentials updated for octocat") {
		t.Errorf("success line should name the resolved user, stderr:\n%s", stderr)
	}
	if !strings.Contains(stderr, "https://github.com/settings/connections/applications") {
		t.Errorf("stderr should print the revocation URL, stderr:\n%s", stderr)
	}
}

func TestRunReauth_NoInputSkipsProviderPhase(t *testing.T) {
	// --no-input --reauth: the flag is the confirmation — ConfirmFn is never
	// called, the provider phase is skipped, auth.json is still updated.
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)

	confirmCalled := false
	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.NoInput = true
		d.ConfirmFn = func(string) (bool, error) {
			confirmCalled = true
			return true, nil
		}
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if confirmCalled {
		t.Error("--no-input must not call ConfirmFn (the flag is the confirmation)")
	}
	auth := loadAuthJSON(t)
	if auth.GitHubToken != FakeGitHubToken || auth.GitHubUser != "octocat" || auth.RepoPath != workdir {
		t.Errorf("auth.json must carry the fresh github fields, got %+v", auth)
	}
}

func TestRunReauth_CreatesAuthJSONWhenMissing(t *testing.T) {
	// Settings present but auth.json missing → reauth creates auth.json with
	// the github fields.
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)

	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !authJSONExists(t) {
		t.Fatal("reauth must create auth.json when missing")
	}
	auth := loadAuthJSON(t)
	if auth.GitHubToken != FakeGitHubToken || auth.GitHubUser != "octocat" || auth.RepoPath != workdir {
		t.Errorf("expected fresh github fields, got %+v", auth)
	}
}

func TestRunReauth_ErrUnsupportedHardErrors(t *testing.T) {
	// device.ErrUnsupported on an initialized workspace is a hard error
	// naming --client-id — NO legacy API-key fallback, no provider re-prompt,
	// auth.json untouched.
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	auth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return nil, device.ErrUnsupported
		},
	}
	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.Ports = InitPorts{Auth: auth}
	}))
	if err == nil || !strings.Contains(err.Error(), "--client-id") {
		t.Fatalf("expected hard error naming --client-id, got: %v", err)
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("auth.json must be untouched on ErrUnsupported")
	}
}

func TestRunReauth_DeviceFlowFailureWrapsGitHubAuthError(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	auth := &mockAuthenticator{
		waitFunc: func(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error) {
			return nil, fmt.Errorf("expired_token: device code expired")
		},
	}
	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.Ports = InitPorts{Auth: auth}
	}))
	if err == nil || !strings.Contains(err.Error(), "GitHub authentication failed") || !strings.Contains(err.Error(), "expired_token") {
		t.Fatalf("expected wrapped GitHub authentication failure, got: %v", err)
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("no partial auth.json may be written on device-flow failure")
	}
}

func TestRunReauth_ResolveUserFailureLeavesAuthUntouched(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	// The mock's User fails (the real deviceFlowAuthenticator fail-opens
	// inside runInitAuth, warning on stderr); runReauth treats the empty
	// login as a hard error and leaves auth.json untouched.
	auth := &mockAuthenticator{
		userFunc: func(ctx context.Context, token string) (string, error) {
			return "", fmt.Errorf("GET /user: 401 Unauthorized")
		},
	}
	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.Ports = InitPorts{Auth: auth}
	}))
	if err == nil || !strings.Contains(err.Error(), "resolve GitHub user") {
		t.Fatalf("expected user-resolution failure, got: %v", err)
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("auth.json must not be patched when user resolution fails (no partial token write)")
	}
}

func TestRunReauth_DeclineAbortsLeavingAuthIdentical(t *testing.T) {
	// Interactive: explicit confirmation gates before the device flow;
	// declining aborts with auth.json byte-identical.
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	flowCalled := false
	auth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			flowCalled = true
			return &device.CodeResponse{UserCode: "ABCD-1234", DeviceCode: "dc", VerificationURI: "https://github.com/login/device"}, nil
		},
	}
	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.NoInput = false
		d.ConfirmFn = func(string) (bool, error) { return false, nil }
		d.Ports = InitPorts{Auth: auth}
	}))
	if err != nil {
		t.Fatalf("declining re-auth must not error, got: %v", err)
	}
	if flowCalled {
		t.Error("device flow must not run after the confirmation is declined")
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("auth.json must be byte-identical after declined re-auth")
	}
}

func TestRunReauth_MalformedSettingsFailsClosed(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, "cheasee-settings.json"), []byte("{not json}"), 0644); err != nil {
		t.Fatal(err)
	}
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	flowCalled := false
	auth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			flowCalled = true
			return &device.CodeResponse{}, nil
		},
	}
	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.Ports = InitPorts{Auth: auth}
	}))
	if err == nil || !strings.Contains(err.Error(), "cheasee-settings.json") {
		t.Fatalf("expected fail-closed settings error, got: %v", err)
	}
	if flowCalled {
		t.Error("device flow must not run when settings are malformed")
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("auth.json must be untouched when settings are malformed")
	}
}

func TestRunReauth_DockerCheckStillRuns(t *testing.T) {
	// Docker check runs before the reauth routing — docker-not-installed
	// aborts with auth.json untouched.
	testutil.RedirectConfigHome(t)
	stubLookPath(t, func(_ string) (string, error) { return "", fmt.Errorf("executable not found in $PATH") })
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
	}))
	if err == nil || !strings.Contains(err.Error(), "Docker is not installed") {
		t.Fatalf("expected docker-not-installed error on the reauth path, got: %v", err)
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("auth.json must be untouched when the docker check fails")
	}
}

func TestRunReauth_NoGitHubRedoesProviderPhaseOnly(t *testing.T) {
	// --reauth --no-github: provider-key phase only — no device flow, no
	// github patch. With --no-input nothing is written (auth.json untouched).
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.NoGitHub = true
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("auth.json must not be partially updated on --no-github --no-input reauth")
	}
}
