package main

import (
	"context"
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
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
	if user != "" {
		t.Errorf("expected empty user from auth (resolved later), got %q", user)
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
