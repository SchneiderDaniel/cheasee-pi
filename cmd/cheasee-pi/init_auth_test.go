package main

import (
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
	// Clone phase artifacts: sibling bare repo + checked-out main worktree.
	if len(clone.cloneArgs) != 1 || len(clone.worktreeAdd) != 1 {
		t.Fatalf("expected one bare clone + one worktree add, got %d/%d", len(clone.cloneArgs), len(clone.worktreeAdd))
	}
	if _, err := os.Stat(filepath.Join(parent, ".bare")); err != nil {
		t.Errorf("bare clone should have run (<parent>/.bare missing): %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, ".git")); err != nil {
		t.Errorf("worktree should be checked out (.git missing): %v", err)
	}
	// Dedicated settings scaffolded at the folder root; pi's file absent.
	if _, err := os.Stat(filepath.Join(workdir, "cheasee-settings.json")); err != nil {
		t.Errorf("cheasee-settings.json missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Errorf("init must not scaffold .pi/settings.json: %v", err)
	}
	// The scaffold persists what init already knows: the canonical repo URL
	// (shorthand normalized to https) and the resolved GitHub login, plus the
	// .pi skeleton dirs that pi needs to exist before it starts.
	raw := testutil.ReadCheaseeSettingsRaw(t, workdir)
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
		if _, err := os.Stat(filepath.Join(workdir, ".pi", dir)); err != nil {
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
