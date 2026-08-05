package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
	"github.com/go-git/go-git/v5/config"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// authJSONExists reports whether auth.json was written to the config dir.
func authJSONExists(t *testing.T) bool {
	t.Helper()
	cfg := &fileRepository{}
	p, err := cfg.Path()
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

// loadAuthJSON reads the saved auth.json back via fileRepository.
func loadAuthJSON(t *testing.T) *Auth {
	t.Helper()
	cfg := &fileRepository{}
	auth, err := cfg.Load(context.Background())
	if err != nil {
		t.Fatalf("load auth.json: %v", err)
	}
	return auth
}

// ──────────────────────────────────────────────
// Phase 1: Docker check tests
// ──────────────────────────────────────────────

func TestInitUseCase_DockerNotInstalled(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubLookPath(t, func(_ string) (string, error) { return "", fmt.Errorf("executable not found in $PATH") })

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.NoGitHub = true }))
	if err == nil {
		t.Fatal("expected error when Docker not installed")
	}
	if !strings.Contains(err.Error(), "Docker is not installed") {
		t.Errorf("error should mention Docker is not installed: %v", err)
	}
	if authJSONExists(t) {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerNotRunning(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, fmt.Errorf("Cannot connect to the Docker daemon"), "", nil)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.NoGitHub = true }))
	if err == nil {
		t.Fatal("expected error when Docker not running")
	}
	if !strings.Contains(err.Error(), "not running") {
		t.Errorf("error should mention Docker not running: %v", err)
	}
	if authJSONExists(t) {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerVersionTooOld(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "23.0.0", nil)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.NoGitHub = true }))
	if err == nil {
		t.Fatal("expected error when Docker version too old")
	}
	if !strings.Contains(err.Error(), "Docker") {
		t.Errorf("error should mention Docker: %v", err)
	}
	if authJSONExists(t) {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerCheckReturnsErr(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "", fmt.Errorf("version check failed"))

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.NoGitHub = true }))
	if err == nil {
		t.Fatal("expected error when Docker version fetch fails")
	}
	if !strings.Contains(err.Error(), "Docker version check") {
		t.Errorf("error should mention Docker version check: %v", err)
	}
}

func TestInitUseCase_NoDockerCheckFlag(t *testing.T) {
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.NoDockerCheck = true
		d.APIKey = FakeAPIKey
	}))
	if err != nil {
		t.Fatalf("unexpected error with --no-docker-check: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called when --no-docker-check is set")
	}
	if got := loadAuthJSON(t).APIKey; got != FakeAPIKey {
		t.Errorf("expected saved key %q, got %q", FakeAPIKey, got)
	}
}

func TestInitUseCase_HappyPathWithAPIKeyFlag(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err != nil {
		t.Fatalf("unexpected error on happy path: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called on happy path")
	}
	if got := loadAuthJSON(t).APIKey; got != FakeAPIKey {
		t.Errorf("expected API key %q, got %q", FakeAPIKey, got)
	}
}

func TestInitUseCase_ConfigSaveError(t *testing.T) {
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	// Block the config dir path with a regular file so MkdirAll fails
	// deterministically (real file I/O, no mock error injection).
	dir := testutil.RedirectConfigHome(t)
	if err := os.WriteFile(filepath.Join(dir, "cheasee-pi"), []byte("block"), 0644); err != nil {
		t.Fatalf("block config dir: %v", err)
	}

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err == nil {
		t.Fatal("expected error when Save fails")
	}
	if !strings.Contains(err.Error(), "save auth config") {
		t.Errorf("error should wrap with 'save auth config': %v", err)
	}
}

func TestInitUseCase_ContextCancelled(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled

	err := runInit(ctx, initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err == nil {
		t.Fatal("expected error with cancelled context")
	}
	if !strings.Contains(err.Error(), "context") {
		t.Errorf("error should mention context cancellation: %v", err)
	}
}

// ──────────────────────────────────────────────
// Phase 2: Working dir probe tests
// ──────────────────────────────────────────────

func TestInitProbe_Empty(t *testing.T) {
	called := false
	confirm := func(title string) (bool, error) {
		called = true
		return true, nil
	}
	proceed, err := runInitProbe(context.Background(), t.TempDir(), confirm, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !proceed {
		t.Error("expected to proceed for empty dir")
	}
	if called {
		t.Error("confirmFn should not be called for an empty dir")
	}
}

func TestInitProbe_NoInputProceeds(t *testing.T) {
	// Non-interactive mode proceeds even with existing setup markers.
	called := false
	confirm := func(title string) (bool, error) {
		called = true
		return true, nil
	}
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".git"), 0755)
	os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("version: '3'\n"), 0644)

	proceed, err := runInitProbe(context.Background(), dir, confirm, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !proceed {
		t.Error("expected to proceed when noInput is true")
	}
	if called {
		t.Error("confirmFn should not be called when noInput is true")
	}
}

func TestInitProbe_PromptsAndAccepts(t *testing.T) {
	tests := []struct {
		name      string
		setup     func(dir string)
		wantTitle string
	}{
		{
			name:  "repo only",
			setup: func(dir string) { os.MkdirAll(filepath.Join(dir, ".git"), 0755) },
			wantTitle: "Git repository detected but no docker-compose.yml. Re-apply configuration?",
		},
		{
			name:  "compose only",
			setup: func(dir string) { os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("version: '3'\n"), 0644) },
			wantTitle: "Docker compose files detected but no git repository. Re-apply configuration?",
		},
		{
			name: "complete",
			setup: func(dir string) {
				os.MkdirAll(filepath.Join(dir, ".git"), 0755)
				os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("version: '3'\n"), 0644)
			},
			wantTitle: "Existing cheasee-pi setup detected. Re-apply configuration?",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			tt.setup(dir)

			var gotTitle string
			confirm := func(title string) (bool, error) {
				gotTitle = title
				return true, nil
			}
			proceed, err := runInitProbe(context.Background(), dir, confirm, false)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !proceed {
				t.Error("expected to proceed when user accepts")
			}
			if gotTitle != tt.wantTitle {
				t.Errorf("expected confirm title %q, got %q", tt.wantTitle, gotTitle)
			}
		})
	}
}

func TestInitProbe_UserDeclines(t *testing.T) {
	tests := []struct {
		name  string
		setup func(dir string)
	}{
		{name: "repo only", setup: func(dir string) { os.MkdirAll(filepath.Join(dir, ".git"), 0755) }},
		{name: "compose only", setup: func(dir string) { os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("version: '3'\n"), 0644) }},
		{name: "complete", setup: func(dir string) {
			os.MkdirAll(filepath.Join(dir, ".git"), 0755)
			os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("version: '3'\n"), 0644)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			tt.setup(dir)

			proceed, err := runInitProbe(context.Background(), dir, mockConfirmFn(false, nil), false)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if proceed {
				t.Error("expected not to proceed when user declines")
			}
		})
	}
}

// ──────────────────────────────────────────────
// Phase 3: Authentication tests (AC1)
// ──────────────────────────────────────────────

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

// ──────────────────────────────────────────────
// Phase 4: Full flow tests
// ──────────────────────────────────────────────

func TestRunInit_FullFlow(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.SubmoduleOps = &mockSubmoduleOps{}
		d.SourceFork = SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}
		d.Workdir = workdir
	}))
	if err != nil {
		t.Fatalf("full flow failed: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called after full flow")
	}
}

func TestRunInit_NoGitHubFlag(t *testing.T) {
	// --no-github flag: extract + env + save all run after auth, with the
	// real in-process adapters (probe, extract, env render, scaffold).
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
	// Real extractor ran: compose files present.
	if _, err := os.Stat(filepath.Join(workdir, "docker", "docker-compose.yml")); err != nil {
		t.Errorf("extract should have run (docker/docker-compose.yml missing): %v", err)
	}
	// Real env renderer ran: docker/.env present with host uid/gid and git identity.
	envVals := testutil.ReadEnvFile(t, workdir)
	if envVals["HOST_UID"] == "" || envVals["HOST_GIT_NAME"] != "Test User" {
		t.Errorf("expected .env with HOST_UID and git identity, got: %v", envVals)
	}
	// Real scaffold ran: .pi/settings.json present.
	if _, err := os.Stat(filepath.Join(workdir, ".pi", "settings.json")); err != nil {
		t.Errorf("scaffold should have run (.pi/settings.json missing): %v", err)
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

	err := runInit(ctx, initDeps(t, func(d *InitDeps) { d.Ports = ports }))
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
}

// ──────────────────────────────────────────────
// Fork already exists test
// ──────────────────────────────────────────────

func TestRunInit_ForkAlreadyExists(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	ports := defaultMocks()

	// Override GitHub client to return fork-already-exists
	ports.GitHub = &mockGitHubClient{
		getUserFunc: func(ctx context.Context, token string) (string, error) {
			return "testuser", nil
		},
		createForkFunc: func(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error) {
			return "", fmt.Errorf("fork already exists")
		},
		waitForkFunc: func(ctx context.Context, token, owner, repo string) error {
			return nil
		},
	}

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Ports = ports
		d.SubmoduleOps = &mockSubmoduleOps{}
		d.SourceFork = SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}
		d.Workdir = workdir
	}))
	if err != nil {
		t.Fatalf("fork-already-exists should not be fatal: %v", err)
	}
}

// ──────────────────────────────────────────────
// Fork non-422 error test
// ──────────────────────────────────────────────

func TestRunInit_ForkNon422Error(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	ports := defaultMocks()

	ports.GitHub = &mockGitHubClient{
		getUserFunc: func(ctx context.Context, token string) (string, error) {
			return "testuser", nil
		},
		createForkFunc: func(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error) {
			return "", fmt.Errorf("forbidden")
		},
	}

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Ports = ports
		d.SourceFork = SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}
		d.Workdir = workdir
	}))
	if err == nil {
		t.Fatal("expected error for non-422 fork error")
	}
}

// ──────────────────────────────────────────────
// Phase 2: parseSubmoduleURLs tests
// ──────────────────────────────────────────────

func TestParseSubmoduleURLs_HappyPath(t *testing.T) {
	result, err := parseSubmoduleURLs([]string{"flask_blogs=https://github.com/user/flask_blogs"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(result))
	}
	if result["flask_blogs"] != "https://github.com/user/flask_blogs" {
		t.Errorf("expected URL, got %q", result["flask_blogs"])
	}
}

func TestParseSubmoduleURLs_SCPStyle(t *testing.T) {
	result, err := parseSubmoduleURLs([]string{"private-pi=git@github.com:user/private-pi.git"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result["private-pi"] != "git@github.com:user/private-pi.git" {
		t.Errorf("expected SCP URL, got %q", result["private-pi"])
	}
}

func TestParseSubmoduleURLs_Multiple(t *testing.T) {
	result, err := parseSubmoduleURLs([]string{"a=https://a.com", "b=https://b.com"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(result))
	}
	if result["a"] != "https://a.com" {
		t.Errorf("expected 'https://a.com', got %q", result["a"])
	}
	if result["b"] != "https://b.com" {
		t.Errorf("expected 'https://b.com', got %q", result["b"])
	}
}

func TestParseSubmoduleURLs_EmptyName(t *testing.T) {
	_, err := parseSubmoduleURLs([]string{"=url"})
	if err == nil {
		t.Fatal("expected error for empty name")
	}
}

func TestParseSubmoduleURLs_EmptyURL(t *testing.T) {
	_, err := parseSubmoduleURLs([]string{"name="})
	if err == nil {
		t.Fatal("expected error for empty URL")
	}
}

func TestParseSubmoduleURLs_MissingEquals(t *testing.T) {
	_, err := parseSubmoduleURLs([]string{"invalid"})
	if err == nil {
		t.Fatal("expected error for missing =")
	}
}

func TestParseSubmoduleURLs_EmptyInput(t *testing.T) {
	result, err := parseSubmoduleURLs([]string{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 0 {
		t.Fatalf("expected empty map, got %d entries", len(result))
	}
}

// ──────────────────────────────────────────────
// Phase 4: runInitSubmodule orchestrator tests
// ──────────────────────────────────────────────

func TestRunInitSubmodule_SkipAll(t *testing.T) {
	mc := &mockSubmoduleOps{}
	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, true, nil, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mc.listSubmodulesCalled {
		t.Error("ListSubmodules should not be called when skipAll is true")
	}
	if mc.setSubmoduleURLCalled {
		t.Error("SetSubmoduleURL should not be called when skipAll is true")
	}
	if mc.initAndUpdateCalled {
		t.Error("InitAndUpdateSubmodules should not be called when skipAll is true")
	}
}

func TestRunInitSubmodule_NoOverridesNoPrompt(t *testing.T) {
	mc := submoduleFixture(false)

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, false, nil, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !mc.listSubmodulesCalled {
		t.Error("ListSubmodules should be called")
	}
	if mc.setSubmoduleURLCalled {
		t.Error("SetSubmoduleURL should not be called with no overrides")
	}
	if !mc.initAndUpdateCalled {
		t.Error("InitAndUpdateSubmodules should be called")
	}
}

func TestRunInitSubmodule_WithPromptReturnsEmpty(t *testing.T) {
	mc := submoduleFixture(true)

	promptFn := func(sms []config.Submodule) (map[string]string, error) {
		return nil, nil // user accepted all defaults
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, false, promptFn, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mc.setSubmoduleURLCalled {
		t.Error("SetSubmoduleURL should not be called with no changes")
	}
	if !mc.initAndUpdateCalled {
		t.Error("InitAndUpdateSubmodules should be called")
	}
}

func TestRunInitSubmodule_UrlOverridesOne(t *testing.T) {
	mc := submoduleFixture(false)

	urlOverrides := map[string]string{
		"flask_blogs": "https://github.com/user/flask_blogs",
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), urlOverrides, false, nil, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !mc.setSubmoduleURLCalled {
		t.Error("SetSubmoduleURL should be called")
	}
	if mc.setSubmoduleURLName != "flask_blogs" {
		t.Errorf("expected flask_blogs, got %q", mc.setSubmoduleURLName)
	}
	if mc.setSubmoduleURLURL != "https://github.com/user/flask_blogs" {
		t.Errorf("expected URL, got %q", mc.setSubmoduleURLURL)
	}
	if !mc.initAndUpdateCalled {
		t.Error("InitAndUpdateSubmodules should be called")
	}
}

func TestRunInitSubmodule_UrlOverridesBoth(t *testing.T) {
	mc := submoduleFixture(false)
	mc.setSubmoduleURLFunc = func(ctx context.Context, repoPath, name, url string) error {
		return nil
	}

	urlOverrides := map[string]string{
		"flask_blogs": "https://github.com/user/flask_blogs",
		"private-pi":  "https://github.com/user/private-pi.git",
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), urlOverrides, false, nil, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Should have called SetSubmoduleURL for both
	if len(mc.setSubmoduleURLCalls) != 2 {
		t.Errorf("expected 2 SetSubmoduleURL calls, got %d", len(mc.setSubmoduleURLCalls))
	}
}

func TestRunInitSubmodule_PromptReturnsOverride(t *testing.T) {
	mc := submoduleFixture(false)

	promptFn := func(sms []config.Submodule) (map[string]string, error) {
		return map[string]string{
			"flask_blogs": "https://github.com/user/flask_blogs",
		}, nil
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, false, promptFn, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !mc.setSubmoduleURLCalled {
		t.Error("SetSubmoduleURL should be called for the prompted override")
	}
	if mc.setSubmoduleURLName != "flask_blogs" {
		t.Errorf("expected flask_blogs, got %q", mc.setSubmoduleURLName)
	}
}

func TestRunInitSubmodule_OverridesPrecedePrompt(t *testing.T) {
	mc := submoduleFixture(true)

	// Prompt returns one URL, but override wins
	promptFn := func(sms []config.Submodule) (map[string]string, error) {
		return map[string]string{
			"flask_blogs": "https://github.com/prompt/flask_blogs",
		}, nil
	}

	urlOverrides := map[string]string{
		"flask_blogs": "https://github.com/cli/flask_blogs",
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), urlOverrides, false, promptFn, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mc.setSubmoduleURLURL != "https://github.com/cli/flask_blogs" {
		t.Errorf("expected CLI override URL, got %q", mc.setSubmoduleURLURL)
	}
}

func TestRunInitSubmodule_ListSubmodulesError(t *testing.T) {
	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return nil, fmt.Errorf("repo not found")
		},
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, false, nil, false, nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "repo not found") {
		t.Errorf("expected 'repo not found', got %v", err)
	}
}

func TestRunInitSubmodule_SetSubmoduleURLError(t *testing.T) {
	mc := submoduleFixture(true)
	mc.setSubmoduleURLFunc = func(ctx context.Context, repoPath, name, url string) error {
		return fmt.Errorf("invalid URL")
	}

	urlOverrides := map[string]string{
		"flask_blogs": "https://github.com/user/flask_blogs",
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), urlOverrides, false, nil, false, nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "invalid URL") {
		t.Errorf("expected 'invalid URL', got %v", err)
	}
}

func TestRunInitSubmodule_InitAndUpdateError(t *testing.T) {
	mc := submoduleFixture(true)
	mc.initAndUpdateSubmodFunc = func(ctx context.Context, repoPath string) error {
		return fmt.Errorf("update failed")
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, false, nil, false, nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "update failed") {
		t.Errorf("expected 'update failed', got %v", err)
	}
}

func TestRunInitSubmodule_PromptError(t *testing.T) {
	mc := submoduleFixture(true)

	promptFn := func(sms []config.Submodule) (map[string]string, error) {
		return nil, fmt.Errorf("user cancelled")
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, false, promptFn, false, nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "user cancelled") {
		t.Errorf("expected 'user cancelled', got %v", err)
	}
}

func TestRunInitSubmodule_ContextCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return nil, ctx.Err()
		},
	}

	err := runInitSubmodule(ctx, mc, t.TempDir(), nil, false, nil, false, nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestRunInitSubmodule_EmptySubmoduleList(t *testing.T) {
	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return []config.Submodule{}, nil
		},
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, false, nil, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mc.setSubmoduleURLCalled {
		t.Error("SetSubmoduleURL should not be called with empty list")
	}
	if mc.initAndUpdateCalled {
		t.Error("InitAndUpdateSubmodules should not be called with empty list")
	}
}

func TestRunInitSubmodule_OverrideNonExistentSubmodule(t *testing.T) {
	mc := submoduleFixture(true)
	mc.setSubmoduleURLFunc = func(ctx context.Context, repoPath, name, url string) error {
		return fmt.Errorf("submodule %q not found in .gitmodules", name)
	}

	urlOverrides := map[string]string{
		"nonexistent": "https://github.com/user/nonexistent",
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), urlOverrides, false, nil, false, nil, nil)
	if err == nil {
		t.Fatal("expected error for non-existent submodule")
	}
}

// ──────────────────────────────────────────────
// Extract tests
// ──────────────────────────────────────────────

func TestRunInitExtract_Success(t *testing.T) {
	dir := t.TempDir()
	if err := runInitExtract(context.Background(), dir); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, name := range []string{"docker-compose.yml", "Dockerfile", "entrypoint.sh"} {
		if _, err := os.Stat(filepath.Join(dir, "docker", name)); err != nil {
			t.Errorf("expected extracted docker/%s: %v", name, err)
		}
	}
}

func TestRunInitExtract_LogMessage(t *testing.T) {
	// Capture stderr to verify the log message includes the /docker suffix.
	dir := t.TempDir()
	stderr := testutil.CaptureStderr(t, func() {
		if err := runInitExtract(context.Background(), dir); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	expectedSuffix := dir + "/docker"
	if !strings.Contains(stderr, expectedSuffix) {
		t.Errorf("log message should contain %q, got: %s", expectedSuffix, stderr)
	}
	if !strings.Contains(stderr, "Compose files extracted to") {
		t.Errorf("log message should mention extraction, got: %s", stderr)
	}
}

// ──────────────────────────────────────────────
// Env generation tests
// ──────────────────────────────────────────────

func TestRunInitEnv_Success(t *testing.T) {
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	if err := runInitEnv(context.Background(), workdir, mockConfirmFn(true, nil)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	vals := testutil.ReadEnvFile(t, workdir)
	if vals["HOST_UID"] == "" {
		t.Error("expected non-empty HOST_UID")
	}
	if vals["HOST_GID"] == "" {
		t.Error("expected non-empty HOST_GID")
	}
	if vals["HOST_GIT_NAME"] != "Test User" {
		t.Errorf("expected HOST_GIT_NAME 'Test User', got %q", vals["HOST_GIT_NAME"])
	}
	if vals["HOST_GIT_EMAIL"] != "test@example.com" {
		t.Errorf("expected HOST_GIT_EMAIL 'test@example.com', got %q", vals["HOST_GIT_EMAIL"])
	}
}

func TestRunInitEnv_GitIdentityFallback(t *testing.T) {
	// Empty git config + declined identity prompt → defaults written.
	testutil.SetGitConfig(t, "")

	workdir := t.TempDir()
	if err := runInitEnv(context.Background(), workdir, mockConfirmFn(false, nil)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	vals := testutil.ReadEnvFile(t, workdir)
	if vals["HOST_GIT_NAME"] != "Cheasee-Pi" {
		t.Errorf("expected default HOST_GIT_NAME 'Cheasee-Pi', got %q", vals["HOST_GIT_NAME"])
	}
	if vals["HOST_GIT_EMAIL"] != "cheasee-pi@localhost" {
		t.Errorf("expected default HOST_GIT_EMAIL 'cheasee-pi@localhost', got %q", vals["HOST_GIT_EMAIL"])
	}
	if vals["HOST_UID"] == "" {
		t.Error("expected non-empty HOST_UID")
	}
}

// ──────────────────────────────────────────────
// Scaffold phase tests (real templateSettingsRenderer)
// ──────────────────────────────────────────────

func TestRunInitScaffold_IdentityFromConfig(t *testing.T) {
	testutil.SetGitConfig(t, testGitIdentityConfig)
	withInitProvider(t, "opencode-go")

	workdir := t.TempDir()
	if err := runInitScaffold(context.Background(), workdir, mockConfirmFn(true, nil)); err != nil {
		t.Fatalf("scaffold failed: %v", err)
	}

	raw := testutil.ReadSettingsRaw(t, workdir)
	if raw["defaultProvider"] != "opencode-go" {
		t.Errorf("expected defaultProvider 'opencode-go', got %v", raw["defaultProvider"])
	}
	gitID, ok := raw["gitIdentity"].(map[string]any)
	if !ok {
		t.Fatal("expected gitIdentity object")
	}
	if gitID["name"] != "Test User" {
		t.Errorf("expected gitIdentity.name 'Test User', got %v", gitID["name"])
	}
	if gitID["email"] != "test@example.com" {
		t.Errorf("expected gitIdentity.email 'test@example.com', got %v", gitID["email"])
	}
}

func TestRunInitScaffold_DefaultsOnEmptyIdentity(t *testing.T) {
	testutil.SetGitConfig(t, "")
	withInitProvider(t, "opencode-go")

	workdir := t.TempDir()
	// Declined identity prompt → default name/email written.
	if err := runInitScaffold(context.Background(), workdir, mockConfirmFn(false, nil)); err != nil {
		t.Fatalf("scaffold failed: %v", err)
	}

	raw := testutil.ReadSettingsRaw(t, workdir)
	gitID, ok := raw["gitIdentity"].(map[string]any)
	if !ok {
		t.Fatal("expected gitIdentity object")
	}
	if gitID["name"] != "Cheasee-Pi" {
		t.Errorf("expected default gitIdentity.name 'Cheasee-Pi', got %v", gitID["name"])
	}
	if gitID["email"] != "cheasee-pi@localhost" {
		t.Errorf("expected default gitIdentity.email 'cheasee-pi@localhost', got %v", gitID["email"])
	}
}

// ──────────────────────────────────────────────
// InitDeps.Validate tests
// ──────────────────────────────────────────────

func TestInitDeps_Validate(t *testing.T) {
	all := defaultMocks()
	tests := []struct {
		name    string
		ports   func() InitPorts
		deps    InitDeps
		wantErr []string // substrings the error must mention; empty = no error
	}{
		{
			name:  "all present",
			ports: func() InitPorts { return all },
		},
		{
			name:  "missing auth/github on github path",
			ports: func() InitPorts { p := all; p.Auth = nil; p.GitHub = nil; return p },
			deps:    InitDeps{NoGitHub: false},
			wantErr: []string{"Ports.Auth", "Ports.GitHub"},
		},
		{
			name:  "missing auth allowed on no-github path",
			ports: func() InitPorts { p := all; p.Auth = nil; return p },
			deps:    InitDeps{NoGitHub: true},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			deps := tt.deps
			deps.Ports = tt.ports()
			err := deps.Validate()
			if len(tt.wantErr) == 0 {
				if err != nil {
					t.Errorf("expected nil error, got %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error mentioning %v", tt.wantErr)
			}
			for _, want := range tt.wantErr {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error should mention %q: %v", want, err)
				}
			}
		})
	}
}

// ──────────────────────────────────────────────
// Success message test
// ──────────────────────────────────────────────

func TestInit_SuccessMessage(t *testing.T) {
	testutil.SetGitConfig(t, testGitIdentityConfig)

	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.RedirectConfigHome(t)

	output := testutil.CaptureStderr(t, func() {
		err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
			d.NoGitHub = true
			d.APIKey = FakeAPIKey
		}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	if strings.Contains(output, "cheasee-pi start") {
		t.Error("success message must NOT reference 'cheasee-pi start'")
	}
	if !strings.Contains(output, "bash docker/run-pi.sh") {
		t.Error("success message must contain the convenience script command")
	}
	if !strings.Contains(output, "✅ Init complete") {
		t.Error("success message must contain the checkmark and 'Init complete'")
	}
}

// ──────────────────────────────────────────────
// Auth per-provider schema tests (entity layer)
// ──────────────────────────────────────────────

func TestAuthPerProvider_MarshalHasProviderSlot(t *testing.T) {
	auth := &Auth{
		APIKey:   FakeAPIKey,
		Provider: "opencode-go",
	}

	data := marshalAuth(t, auth)

	// Must contain the provider-keyed object
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal of output failed: %v", err)
	}

	providerEntry, ok := raw["opencode-go"]
	if !ok {
		t.Fatal("expected 'opencode-go' key in marshaled JSON")
	}
	entry, ok := providerEntry.(map[string]any)
	if !ok {
		t.Fatal("expected provider entry to be an object")
	}
	if entry["key"] != FakeAPIKey {
		t.Errorf("expected key %q, got %v", FakeAPIKey, entry["key"])
	}

	// Must NOT have flat api_key field
	if _, ok := raw["api_key"]; ok {
		t.Error("expected no flat 'api_key' field when Provider is set")
	}
}

func TestAuthPerProvider_MarshalNoProviderWritesFlat(t *testing.T) {
	auth := &Auth{
		APIKey: FakeAPIKey,
		// Provider is empty — should write flat api_key
	}

	data := marshalAuth(t, auth)

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal of output failed: %v", err)
	}

	if _, ok := raw["api_key"]; !ok {
		t.Error("expected flat 'api_key' field when Provider is empty")
	}
	if raw["api_key"] != FakeAPIKey {
		t.Errorf("expected api_key %q, got %v", FakeAPIKey, raw["api_key"])
	}
}

func TestAuthPerProvider_MarshalEmptyProviderNoKey(t *testing.T) {
	// GitHub-only auth: no Provider, no APIKey
	// When Provider is empty, api_key is always written at top level for
	// backward compatibility (even if empty string), preserving the
	// pre-existing TestConfigSave_EmptyAPIKey contract.
	auth := &Auth{
		GitHubToken: FakeGitHubToken,
		GitHubUser:  "testuser",
		RepoPath:    "/workspace",
	}

	data := marshalAuth(t, auth)

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal of output failed: %v", err)
	}

	// api_key is written even when empty because Provider is empty —
	// this maintains backward compat with pre-existing TestConfigSave_EmptyAPIKey
	if v, ok := raw["api_key"]; ok {
		if v != "" {
			t.Errorf("expected empty api_key string, got %v", v)
		}
	} else {
		t.Error("expected 'api_key' field (empty) for backward compat when Provider is empty")
	}
	if raw["github_token"] != FakeGitHubToken {
		t.Errorf("expected github_token %q, got %v", FakeGitHubToken, raw["github_token"])
	}
}

func TestAuthPerProvider_UnmarshalProviderFormat(t *testing.T) {
	data := []byte(fmt.Sprintf(`{
		"opencode-go": {"key": "%s"},
		"github_token": "%s",
		"github_user": "testuser",
		"repo_path": "/workspace"
	}`, FakeAPIKey, FakeGitHubToken))

	var auth Auth
	if err := json.Unmarshal(data, &auth); err != nil {
		t.Fatalf("Unmarshal of provider format failed: %v", err)
	}

	if auth.APIKey != FakeAPIKey {
		t.Errorf("expected APIKey %q, got %q", FakeAPIKey, auth.APIKey)
	}
	if auth.Provider != "opencode-go" {
		t.Errorf("expected Provider 'opencode-go', got %q", auth.Provider)
	}
	if auth.GitHubToken != FakeGitHubToken {
		t.Errorf("expected GitHubToken %q, got %q", FakeGitHubToken, auth.GitHubToken)
	}
	if auth.GitHubUser != "testuser" {
		t.Errorf("expected GitHubUser 'testuser', got %q", auth.GitHubUser)
	}
	if auth.RepoPath != "/workspace" {
		t.Errorf("expected RepoPath '/workspace', got %q", auth.RepoPath)
	}
}

func TestAuthPerProvider_UnmarshalFlatFormat(t *testing.T) {
	data := []byte(fmt.Sprintf(`{"api_key": "%s", "github_token": "%s"}`, FakeAPIKey, FakeGitHubToken))

	var auth Auth
	if err := json.Unmarshal(data, &auth); err != nil {
		t.Fatalf("Unmarshal of flat format failed: %v", err)
	}

	if auth.APIKey != FakeAPIKey {
		t.Errorf("expected APIKey %q, got %q", FakeAPIKey, auth.APIKey)
	}
	if auth.Provider != "" {
		t.Errorf("expected empty Provider for flat format, got %q", auth.Provider)
	}
	if auth.GitHubToken != FakeGitHubToken {
		t.Errorf("expected GitHubToken %q, got %q", FakeGitHubToken, auth.GitHubToken)
	}
}

func TestAuthPerProvider_SaveWritesJqParseableOutput(t *testing.T) {
	testutil.RedirectConfigHome(t)

	cfg := &fileRepository{}
	auth := &Auth{
		APIKey:   FakeAPIKey,
		Provider: "opencode-go",
	}

	if err := cfg.Save(context.Background(), auth); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Read raw file and verify it's valid JSON with expected structure
	path, _ := cfg.Path()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Saved file is not valid JSON: %v", err)
	}

	entry, ok := raw["opencode-go"]
	if !ok {
		t.Fatal("saved file must contain provider key 'opencode-go'")
	}
	entryMap, ok := entry.(map[string]any)
	if !ok {
		t.Fatal("provider entry must be an object")
	}
	if entryMap["key"] != FakeAPIKey {
		t.Errorf("expected key %q, got %v", FakeAPIKey, entryMap["key"])
	}
}

func TestAuthPerProvider_UnmarshalEmptyObject(t *testing.T) {
	data := []byte(`{}`)

	var auth Auth
	if err := json.Unmarshal(data, &auth); err != nil {
		t.Fatalf("Unmarshal of empty object failed: %v", err)
	}

	if auth.APIKey != "" {
		t.Errorf("expected empty APIKey, got %q", auth.APIKey)
	}
	if auth.GitHubToken != "" {
		t.Errorf("expected empty GitHubToken, got %q", auth.GitHubToken)
	}
}

func TestAuthPerProvider_UnmarshalMalformedJSON(t *testing.T) {
	data := []byte(`{not json}`)

	var auth Auth
	err := json.Unmarshal(data, &auth)
	if err == nil {
		t.Fatal("expected error for malformed JSON")
	}
}

func TestAuthPerProvider_RoundTripWithProvider(t *testing.T) {
	testutil.RedirectConfigHome(t)

	cfg := &fileRepository{}
	auth := &Auth{
		APIKey:      FakeAPIKey,
		Provider:    "opencode-go",
		GitHubToken: FakeGitHubToken,
		GitHubUser:  "testuser",
		RepoPath:    "/some/path",
	}

	if err := cfg.Save(context.Background(), auth); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := cfg.Load(context.Background())
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if loaded.APIKey != FakeAPIKey {
		t.Errorf("expected api_key %q, got %q", FakeAPIKey, loaded.APIKey)
	}
	if loaded.Provider != "opencode-go" {
		t.Errorf("expected Provider 'opencode-go', got %q", loaded.Provider)
	}
	if loaded.GitHubToken != FakeGitHubToken {
		t.Errorf("expected GitHubToken %q, got %q", FakeGitHubToken, loaded.GitHubToken)
	}
	if loaded.GitHubUser != "testuser" {
		t.Errorf("expected GitHubUser 'testuser', got %q", loaded.GitHubUser)
	}
	if loaded.RepoPath != "/some/path" {
		t.Errorf("expected RepoPath '/some/path', got %q", loaded.RepoPath)
	}
}

func TestAuthPerProvider_MarshalOmitGitHubTokenWhenEmpty(t *testing.T) {
	auth := &Auth{
		APIKey:   FakeAPIKey,
		Provider: "openai",
	}

	data := marshalAuth(t, auth)

	if bytes.Contains(data, []byte("github_token")) {
		t.Error("expected no github_token in output when empty")
	}
	if !bytes.Contains(data, []byte("openai")) {
		t.Error("expected openai provider key in output")
	}
}

// ──────────────────────────────────────────────
// Legacy/backward compat tests
// ──────────────────────────────────────────────

func TestConfigBackwardCompat_OldAuthLoads(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)

	// Write old-format auth.json
	oldDir := filepath.Join(dir, "cheasee-pi")
	os.MkdirAll(oldDir, 0700)
	oldPath := filepath.Join(oldDir, "auth.json")
	oldContent := fmt.Sprintf(`{"api_key": "%s"}`, FakeAPIKey)
	os.WriteFile(oldPath, []byte(oldContent), 0600)

	cfg := &fileRepository{}
	auth, err := cfg.Load(context.Background())
	if err != nil {
		t.Fatalf("Load of old format failed: %v", err)
	}
	if auth.APIKey != FakeAPIKey {
		t.Errorf("expected API key %q, got %q", FakeAPIKey, auth.APIKey)
	}
	if auth.GitHubToken != "" {
		t.Errorf("expected empty GitHubToken for old format, got %q", auth.GitHubToken)
	}
}

func TestConfigBackwardCompat_RoundTripPreservesNewFields(t *testing.T) {
	testutil.RedirectConfigHome(t)

	cfg := &fileRepository{}
	auth := &Auth{
		APIKey:      FakeAPIKey,
		GitHubToken: FakeGitHubToken,
		GitHubUser:  "testuser",
		RepoPath:    "/some/path",
	}

	if err := cfg.Save(context.Background(), auth); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := cfg.Load(context.Background())
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if loaded.APIKey != FakeAPIKey {
		t.Errorf("expected api_key %q, got %q", FakeAPIKey, loaded.APIKey)
	}
	if loaded.GitHubToken != FakeGitHubToken {
		t.Errorf("expected GitHubToken %q, got %q", FakeGitHubToken, loaded.GitHubToken)
	}
	if loaded.GitHubUser != "testuser" {
		t.Errorf("expected GitHubUser 'testuser', got %q", loaded.GitHubUser)
	}
	if loaded.RepoPath != "/some/path" {
		t.Errorf("expected RepoPath '/some/path', got %q", loaded.RepoPath)
	}
}

// ──────────────────────────────────────────────
// CLI flag tests
// ──────────────────────────────────────────────

func TestInitCmd_HelpShowsNewFlags(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "init", "--help")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	expectedFlags := []string{"--workdir", "--source-repo", "--no-github", "--client-id", "--provider", "--skip-fork", "--fork-url", "--no-input", "--submodule-url", "--skip-submodules"}
	for _, flag := range expectedFlags {
		if !strings.Contains(output, flag) {
			t.Errorf("init --help output should show %q flag", flag)
		}
	}
}

// ──────────────────────────────────────────────
// Phase 1: SourceForkMode constants (entity layer)
// ──────────────────────────────────────────────

func TestSourceForkMode_Constants(t *testing.T) {
	// Verify all three are distinct
	if ModePromptFork == ModeUseForkURL || ModePromptFork == ModeSkipFork || ModeUseForkURL == ModeSkipFork {
		t.Error("SourceForkMode constants must be distinct")
	}
}

func TestSourceForkInput_Defaults(t *testing.T) {
	sfi := SourceForkInput{}
	if sfi.Mode != ModePromptFork {
		t.Errorf("expected ModePromptFork (0), got %d", sfi.Mode)
	}
	if sfi.SourceRepo != "" {
		t.Errorf("expected empty SourceRepo, got %q", sfi.SourceRepo)
	}
	if sfi.ForkURL != "" {
		t.Errorf("expected empty ForkURL, got %q", sfi.ForkURL)
	}
}

func TestSourceForkInput_RoundTrip(t *testing.T) {
	sfi := SourceForkInput{
		Mode:       ModeUseForkURL,
		SourceRepo: "user/repo",
		ForkURL:    "https://github.com/user/repo.git",
	}
	if sfi.Mode != ModeUseForkURL {
		t.Errorf("expected ModeUseForkURL, got %d", sfi.Mode)
	}
	if sfi.SourceRepo != "user/repo" {
		t.Errorf("expected 'user/repo', got %q", sfi.SourceRepo)
	}
	if sfi.ForkURL != "https://github.com/user/repo.git" {
		t.Errorf("expected fork URL, got %q", sfi.ForkURL)
	}
}

// ──────────────────────────────────────────────
// Phase 2: runInitPromptSource tests (use-case layer)
// ──────────────────────────────────────────────

func TestRunInitPromptSource_EmptyInputDefaults(t *testing.T) {
	result, err := runInitPromptSource(SourceForkInput{Mode: ModePromptFork})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "SchneiderDaniel/cheasee-pi" {
		t.Errorf("expected default 'SchneiderDaniel/cheasee-pi', got %q", result)
	}
}

func TestRunInitPromptSource_UserInput(t *testing.T) {
	result, err := runInitPromptSource(SourceForkInput{Mode: ModePromptFork, SourceRepo: "user/repo"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "user/repo" {
		t.Errorf("expected 'user/repo', got %q", result)
	}
}

func TestRunInitPromptSource_NoInputFlag(t *testing.T) {
	result, err := runInitPromptSource(SourceForkInput{Mode: ModePromptFork})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "SchneiderDaniel/cheasee-pi" {
		t.Errorf("expected default, got %q", result)
	}
}

func TestRunInitPromptSource_SourceRepoFlag(t *testing.T) {
	result, err := runInitPromptSource(SourceForkInput{Mode: ModePromptFork, SourceRepo: "org/custom"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "org/custom" {
		t.Errorf("expected 'org/custom', got %q", result)
	}
}

func TestRunInitPromptSource_ForkURLMode(t *testing.T) {
	result, err := runInitPromptSource(SourceForkInput{Mode: ModeUseForkURL, ForkURL: "https://github.com/user/existing-fork.git"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "user/existing-fork" {
		t.Errorf("expected 'user/existing-fork', got %q", result)
	}
}

// ──────────────────────────────────────────────
// Phase 4: Orchestration tests
// ──────────────────────────────────────────────

func TestRunInit_SkipFork(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.SourceFork = SourceForkInput{Mode: ModeSkipFork}
		d.Workdir = workdir
	}))
	if err != nil {
		t.Fatalf("skip-fork flow failed: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called after skip-fork flow")
	}
}

func TestRunInit_ForkURL(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	submoduleInited := false
	ops := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return []config.Submodule{{Name: "pi", URL: "https://github.com/SchneiderDaniel/pi.git"}}, nil
		},
		initAndUpdateSubmodFunc: func(ctx context.Context, repoPath string) error {
			submoduleInited = true
			return nil
		},
	}

	// Capture the CloneWorktree seam args (git clone --bare <authURL> <dir>)
	var cloneURL string
	savedRun := runCommandContext
	runCommandContext = func(_ context.Context, _ string, arg ...string) runner {
		if len(arg) > 0 && arg[0] == "clone" {
			cloneURL = arg[2]
			return &mockCmd{}
		}
		if len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("24.0.9"), nil }}
		}
		return &mockCmd{}
	}
	defer func() { runCommandContext = savedRun }()

	ports := defaultMocks()

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Ports = ports
		d.SubmoduleOps = ops
		d.SourceFork = SourceForkInput{Mode: ModeUseForkURL, ForkURL: "https://github.com/user/existing-fork.git"}
		d.Workdir = workdir
	}))
	if err != nil {
		t.Fatalf("fork-url flow failed: %v", err)
	}
	if cloneURL == "" {
		t.Error("CloneWorktree should be called with fork URL")
	}
	if cloneURL != "https://oauth2:"+FakeGitHubToken+"@github.com/user/existing-fork.git" {
		t.Errorf("expected tokenized clone URL, got %q", cloneURL)
	}
	if !submoduleInited {
		t.Error("Submodule init should be called with fork URL")
	}
	if !authJSONExists(t) {
		t.Error("Save should be called after fork-url flow")
	}
}

func TestRunInit_ForkURLSkipsCreateFork(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	forkCalled := false
	waitForkCalled := false
	mockGH := &mockGitHubClient{
		getUserFunc: func(ctx context.Context, token string) (string, error) {
			return "testuser", nil
		},
		createForkFunc: func(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error) {
			forkCalled = true
			return "testuser/cheasee-pi", nil
		},
		waitForkFunc: func(ctx context.Context, token, owner, repo string) error {
			waitForkCalled = true
			return nil
		},
	}

	mockAuth := &mockAuthenticator{}
	ports := defaultMocks()
	ports.Auth = mockAuth
	ports.GitHub = mockGH

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Ports = ports
		d.SubmoduleOps = &mockSubmoduleOps{}
		d.SourceFork = SourceForkInput{Mode: ModeUseForkURL, ForkURL: "https://github.com/user/existing-fork.git"}
		d.Workdir = workdir
	}))
	if err != nil {
		t.Fatalf("fork-url flow failed: %v", err)
	}
	if forkCalled {
		t.Error("CreateFork should NOT be called when --fork-url is used")
	}
	if waitForkCalled {
		t.Error("WaitForkReady should NOT be called when --fork-url is used")
	}
}

func TestRunInit_ForkURLInvalid(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.SourceFork = SourceForkInput{Mode: ModeUseForkURL, ForkURL: ""}
		d.Workdir = workdir
	}))
	if err == nil {
		t.Fatal("expected error for invalid fork URL")
	}
	if !strings.Contains(err.Error(), "invalid clone URL") {
		t.Errorf("error should mention invalid clone URL: %v", err)
	}
}

// ──────────────────────────────────────────────
// Phase 5: Post-clone confirm tests
// ──────────────────────────────────────────────

func TestRunInit_PostCloneConfirm_Accepted(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.SubmoduleOps = &mockSubmoduleOps{}
		d.NoInput = false
		d.SourceFork = SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}
		d.Workdir = workdir
		d.ConfirmFn = mockConfirmFn(true, nil, "Configure API keys")
	}))
	if err != nil {
		t.Fatalf("post-clone confirm flow failed: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called when confirm is accepted")
	}
}

func TestRunInit_PostCloneConfirm_Declined(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoInput = false
		d.SourceFork = SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}
		d.Workdir = workdir
		d.ConfirmFn = mockConfirmFn(false, nil)
	}))
	if err != nil {
		t.Fatalf("expected nil error (clean exit) when confirm is declined: %v", err)
	}
	if authJSONExists(t) {
		t.Error("Save should NOT be called when confirm is declined")
	}
}

func TestRunInit_PostCloneConfirm_NoInputSkipsPrompt(t *testing.T) {
	// With noInput=true, the post-clone confirm should be skipped
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	// If confirm were called with false, we'd error (but it won't be called)
	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.SubmoduleOps = &mockSubmoduleOps{}
		d.SourceFork = SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}
		d.Workdir = workdir
		d.ConfirmFn = nil
	}))
	if err != nil {
		t.Fatalf("post-clone confirm with noInput=true failed: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called when noInput skips prompt")
	}
}
// ──────────────────────────────────────────────
// Phase 1: Settings scaffold renderer (entity)
// ──────────────────────────────────────────────

func TestSettingsScaffold_WritesCorrectContent(t *testing.T) {
	workdir := ScaffoldSettings(t, TemplateSettingsValues{
		Provider: "opencode-go",
		GitName:  "Test User",
		GitEmail: "test@example.com",
		Memory:   "4G",
		CPUs:     "4.0",
	})

	raw := testutil.ReadSettingsRaw(t, workdir)
	if raw["defaultProvider"] != "opencode-go" {
		t.Errorf("expected defaultProvider 'opencode-go', got %v", raw["defaultProvider"])
	}
	if raw["defaultModel"] != "gpt-4o" {
		t.Errorf("expected defaultModel 'gpt-4o', got %v", raw["defaultModel"])
	}

	docker, ok := raw["docker"].(map[string]any)
	if !ok {
		t.Fatal("expected docker object")
	}
	if docker["memory"] != "4G" {
		t.Errorf("expected memory '4G', got %v", docker["memory"])
	}
	if docker["cpus"] != "4.0" {
		t.Errorf("expected cpus '4.0', got %v", docker["cpus"])
	}

	gitID, ok := raw["gitIdentity"].(map[string]any)
	if !ok {
		t.Fatal("expected gitIdentity object")
	}
	if gitID["name"] != "Test User" {
		t.Errorf("expected gitIdentity.name 'Test User', got %v", gitID["name"])
	}
	if gitID["email"] != "test@example.com" {
		t.Errorf("expected gitIdentity.email 'test@example.com', got %v", gitID["email"])
	}
}

func TestSettingsScaffold_Idempotent(t *testing.T) {
	workdir := ScaffoldSettings(t, TemplateSettingsValues{
		Provider: "opencode-go",
		GitName:  "Original",
		GitEmail: "orig@example.com",
		Memory:   "2G",
		CPUs:     "2.0",
	})

	// Second call: should no-op (file exists)
	if err := NewSettingsScaffold().Scaffold(context.Background(), workdir, TemplateSettingsValues{
		Provider: "overwrite",
		GitName:  "Overwrite",
		GitEmail: "overwrite@example.com",
		Memory:   "8G",
		CPUs:     "8.0",
	}); err != nil {
		t.Fatalf("second Scaffold failed: %v", err)
	}

	// Content must still be from first call (unchanged)
	raw := testutil.ReadSettingsRaw(t, workdir)
	if raw["defaultProvider"] != "opencode-go" {
		t.Errorf("expected defaultProvider 'opencode-go' (unchanged), got %v", raw["defaultProvider"])
	}
}

func TestSettingsScaffold_EmptyValues(t *testing.T) {
	workdir := ScaffoldSettings(t, TemplateSettingsValues{}) // all empty

	raw := testutil.ReadSettingsRaw(t, workdir)

	// Empty values should be empty strings in output
	if raw["defaultProvider"] != "" {
		t.Errorf("expected empty defaultProvider, got %v", raw["defaultProvider"])
	}

	gitID, ok := raw["gitIdentity"].(map[string]any)
	if !ok {
		t.Fatal("expected gitIdentity object")
	}
	if gitID["name"] != "" {
		t.Errorf("expected empty gitIdentity.name, got %v", gitID["name"])
	}
	if gitID["email"] != "" {
		t.Errorf("expected empty gitIdentity.email, got %v", gitID["email"])
	}

	docker, ok := raw["docker"].(map[string]any)
	if !ok {
		t.Fatal("expected docker object")
	}
	if docker["memory"] != "" {
		t.Errorf("expected empty docker.memory, got %v", docker["memory"])
	}
	if docker["cpus"] != "" {
		t.Errorf("expected empty docker.cpus, got %v", docker["cpus"])
	}
}

func TestSettingsScaffold_InvalidWorkdir(t *testing.T) {
	scaffold := NewSettingsScaffold()

	vals := TemplateSettingsValues{
		Provider: "opencode-go",
		GitName:  "Test",
		GitEmail: "test@test.com",
		Memory:   "2G",
		CPUs:     "2.0",
	}

	// Pre-create .pi as file so MkdirAll fails with ENOTDIR
	workdir := t.TempDir()
	os.WriteFile(filepath.Join(workdir, ".pi"), []byte(""), 0644)

	err := scaffold.Scaffold(context.Background(), workdir, vals)
	if err == nil {
		t.Fatal("expected error when .pi is a file")
	}
	if !strings.Contains(err.Error(), ".pi") && !strings.Contains(err.Error(), "mkdir") && !strings.Contains(err.Error(), "file") {
		t.Errorf("error should mention .pi, mkdir, or file: %v", err)
	}
}

func TestSettingsScaffold_ContextCancelled(t *testing.T) {
	scaffold := NewSettingsScaffold()
	workdir := t.TempDir()

	vals := TemplateSettingsValues{
		Provider: "opencode-go",
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled

	err := scaffold.Scaffold(ctx, workdir, vals)
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
	if !strings.Contains(err.Error(), "context") {
		t.Errorf("error should mention context: %v", err)
	}
}

// ──────────────────────────────────────────────
// Phase 2: Git initializer (entity)
// ──────────────────────────────────────────────

func TestGitInitializer_Init(t *testing.T) {
	workdir := t.TempDir()

	if err := gitInit(context.Background(), workdir); err != nil {
		t.Fatalf("gitInit failed: %v", err)
	}

	// .git directory should exist
	gitDir := filepath.Join(workdir, ".git")
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		t.Error("expected .git directory to exist after gitInit")
	}
}

func TestGitInitializer_Idempotent(t *testing.T) {
	workdir := t.TempDir()

	// First call: create .git
	if err := gitInit(context.Background(), workdir); err != nil {
		t.Fatalf("first gitInit failed: %v", err)
	}

	// Second call: should no-op
	if err := gitInit(context.Background(), workdir); err != nil {
		t.Fatalf("second gitInit should not error: %v", err)
	}

	// .git still exists
	gitDir := filepath.Join(workdir, ".git")
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		t.Error("expected .git directory to exist after idempotent gitInit")
	}
}

func TestGitInitializer_NonExistentWorkdir(t *testing.T) {
	// Use null byte in path — forces EINVAL from git init
	err := gitInit(context.Background(), "/nonexistent\x00path")
	if err == nil {
		t.Fatal("expected error for invalid path with null byte")
	}
	if !strings.Contains(err.Error(), "git init") {
		t.Errorf("error should mention 'git init': %v", err)
	}
}

func TestGitInitializer_ContextCancelled(t *testing.T) {
	workdir := t.TempDir()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled

	// Seam must not be touched for a pre-cancelled ctx.
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		t.Errorf("runCommandContext should not be invoked with cancelled ctx")
		return &mockCmd{}
	})

	err := gitInit(ctx, workdir)
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
	if !strings.Contains(err.Error(), "context") {
		t.Errorf("error should mention context: %v", err)
	}
}

func TestExtract_SkipsPiSubtree(t *testing.T) {
	ext := NewExtractor()
	workdir := t.TempDir()

	if err := ext.Extract(context.Background(), workdir); err != nil {
		t.Fatalf("Extract failed: %v", err)
	}

	// docker/ should exist
	if _, err := os.Stat(filepath.Join(workdir, "docker", "docker-compose.yml")); os.IsNotExist(err) {
		t.Error("expected docker-compose.yml to be extracted")
	}

	// .pi/ should NOT be extracted (it's consumed by scaffold, not extractor)
	if _, err := os.Stat(filepath.Join(workdir, "pi")); err == nil {
		t.Error("pi/ should not be extracted to workspace")
	}
}

// ──────────────────────────────────────────────
// Phase 5: InitRemover adapter tests
// ──────────────────────────────────────────────

func TestInitRemove_NoFile(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()

	if err := r.Remove(workdir); err != nil {
		t.Fatalf("Remove with no .initremove should return nil: %v", err)
	}
}

func TestInitRemove_OnlyComments(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), []byte("# comment\n\n  # another\n"), 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}

	if err := r.Remove(workdir); err != nil {
		t.Fatalf("Remove with only comments should return nil: %v", err)
	}
}

func TestInitRemove_SingleFile(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte("test.md")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	target := filepath.Join(workdir, "test.md")
	if err := os.WriteFile(target, []byte("data"), 0644); err != nil {
		t.Fatalf("write test.md: %v", err)
	}

	// Capture stderr
	stderr := testutil.CaptureStderr(t, func() {
		if err := r.Remove(workdir); err != nil {
			t.Fatalf("Remove failed: %v", err)
		}
	})

	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Error("test.md should be removed")
	}
	if !strings.Contains(stderr, "  ✓ Removed test.md") {
		t.Errorf("expected removal log line, got: %s", stderr)
	}
}

func TestInitRemove_Directory(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte(".github/")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	dir := filepath.Join(workdir, ".github")
	if err := os.MkdirAll(filepath.Join(dir, "workflows"), 0755); err != nil {
		t.Fatalf("create .github dir: %v", err)
	}

	stderr := testutil.CaptureStderr(t, func() {
		if err := r.Remove(workdir); err != nil {
			t.Fatalf("Remove failed: %v", err)
		}
	})

	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error(".github/ should be removed")
	}
	if !strings.Contains(stderr, "  ✓ Removed .github") {
		t.Errorf("expected removal log line, got: %s", stderr)
	}
}

func TestInitRemove_MultiplePatterns(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte("a.md\nb.md")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workdir, "a.md"), []byte("a"), 0644); err != nil {
		t.Fatalf("write a.md: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workdir, "b.md"), []byte("b"), 0644); err != nil {
		t.Fatalf("write b.md: %v", err)
	}

	stderr := testutil.CaptureStderr(t, func() {
		if err := r.Remove(workdir); err != nil {
			t.Fatalf("Remove failed: %v", err)
		}
	})

	if _, err := os.Stat(filepath.Join(workdir, "a.md")); !os.IsNotExist(err) {
		t.Error("a.md should be removed")
	}
	if _, err := os.Stat(filepath.Join(workdir, "b.md")); !os.IsNotExist(err) {
		t.Error("b.md should be removed")
	}
	if !strings.Contains(stderr, "  ✓ Removed a.md") {
		t.Errorf("expected a.md removal log line, got: %s", stderr)
	}
	if !strings.Contains(stderr, "  ✓ Removed b.md") {
		t.Errorf("expected b.md removal log line, got: %s", stderr)
	}
}

func TestInitRemove_GitmodulesProtected(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte(".gitmodules")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workdir, ".gitmodules"), []byte("[submodule \"test\"]\n\tpath = test\n\turl = https://github.com/x/test.git"), 0644); err != nil {
		t.Fatalf("write .gitmodules: %v", err)
	}

	if err := r.Remove(workdir); err != nil {
		t.Fatalf("Remove failed: %v", err)
	}

	if _, err := os.Stat(filepath.Join(workdir, ".gitmodules")); os.IsNotExist(err) {
		t.Error(".gitmodules should be preserved")
	}
}

func TestInitRemove_NonExistentPattern(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte("nonexistent.md")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}

	// Should not error — pattern with zero matches is silently skipped
	if err := r.Remove(workdir); err != nil {
		t.Fatalf("Remove with non-existent pattern should return nil: %v", err)
	}
}

func TestInitRemove_InvalidGlob(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte("unmatched[brackets")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}

	err := r.Remove(workdir)
	if err == nil {
		t.Fatal("expected error for invalid glob syntax")
	}
	if !strings.Contains(err.Error(), "invalid glob pattern") {
		t.Errorf("error should mention invalid glob: %v", err)
	}
}

func TestInitRemove_DeepGlob(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte("**/node_modules/")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	subdir := filepath.Join(workdir, "a", "b", "node_modules")
	if err := os.MkdirAll(subdir, 0755); err != nil {
		t.Fatalf("create nested node_modules: %v", err)
	}
	if err := os.WriteFile(filepath.Join(subdir, "pkg"), []byte("lib"), 0644); err != nil {
		t.Fatalf("write pkg: %v", err)
	}

	stderr := testutil.CaptureStderr(t, func() {
		if err := r.Remove(workdir); err != nil {
			t.Fatalf("Remove failed: %v", err)
		}
	})

	if _, err := os.Stat(subdir); !os.IsNotExist(err) {
		t.Error("nested node_modules/ should be removed")
	}
	if !strings.Contains(stderr, "  ✓ Removed a/b/node_modules") {
		t.Errorf("expected removal log line, got: %s", stderr)
	}
}

func TestInitRemove_TrailingWhitespaceStripped(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	content := []byte("test.md   ")
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), content, 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workdir, "test.md"), []byte("data"), 0644); err != nil {
		t.Fatalf("write test.md: %v", err)
	}

	if err := r.Remove(workdir); err != nil {
		t.Fatalf("Remove failed: %v", err)
	}

	if _, err := os.Stat(filepath.Join(workdir, "test.md")); !os.IsNotExist(err) {
		t.Error("test.md should be removed")
	}
}

func TestInitRemove_InitremoveIsDirectory(t *testing.T) {
	r := &initRemover{}
	workdir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workdir, ".initremove"), 0755); err != nil {
		t.Fatalf("create .initremove dir: %v", err)
	}

	err := r.Remove(workdir)
	if err == nil {
		t.Fatal("expected error when .initremove is a directory")
	}
	if !strings.Contains(err.Error(), "read .initremove") {
		t.Errorf("error should wrap 'read .initremove': %v", err)
	}
}

// ──────────────────────────────────────────────
// Phase 6: Orchestrator tests for InitRemover
// ──────────────────────────────────────────────

// seedCloneFixture pre-seeds a workdir with a .git marker (so the clone
// refusal check passes and clone is skipped), a .initremove manifest listing
// test.md and .github/, both present on disk, and a README.md control file
// that is not listed and must survive cleanup.
func seedCloneFixture(t *testing.T, workdir string) {
	t.Helper()
	os.MkdirAll(filepath.Join(workdir, ".git"), 0755)
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), []byte("test.md\n.github/\n"), 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workdir, "test.md"), []byte("data"), 0644); err != nil {
		t.Fatalf("write test.md: %v", err)
	}
	os.MkdirAll(filepath.Join(workdir, ".github", "workflows"), 0755)
	if err := os.WriteFile(filepath.Join(workdir, "README.md"), []byte("# repo\n"), 0644); err != nil {
		t.Fatalf("write README.md: %v", err)
	}
}

func TestRunInit_RemoverCalled(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	seedCloneFixture(t, workdir)
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.SubmoduleOps = &mockSubmoduleOps{}
		d.SourceFork = SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}
		d.Workdir = workdir
	}))
	if err != nil {
		t.Fatalf("full flow with remover failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, "test.md")); !os.IsNotExist(err) {
		t.Error("test.md should be removed by post-clone cleanup")
	}
	if _, err := os.Stat(filepath.Join(workdir, ".github")); !os.IsNotExist(err) {
		t.Error(".github/ should be removed by post-clone cleanup")
	}
	if _, err := os.Stat(filepath.Join(workdir, "README.md")); err != nil {
		t.Errorf("README.md (not listed in .initremove) should survive: %v", err)
	}
}

func TestRunInit_RemoverError(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)

	workdir := t.TempDir()
	os.MkdirAll(filepath.Join(workdir, ".git"), 0755)
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), []byte("unmatched[brackets\n"), 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.SourceFork = SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}
		d.Workdir = workdir
	}))
	if err == nil {
		t.Fatal("expected error when remover fails")
	}
	if !strings.Contains(err.Error(), "post-clone cleanup") {
		t.Errorf("error should wrap with phase prefix: %v", err)
	}
}

func TestRunInit_RemoverSkipFork(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	seedCloneFixture(t, workdir)
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.SourceFork = SourceForkInput{Mode: ModeSkipFork}
		d.Workdir = workdir
	}))
	if err != nil {
		t.Fatalf("skip-fork flow failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, "test.md")); err != nil {
		t.Errorf("test.md should survive in skip-fork mode (no clone, no cleanup): %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, ".github")); err != nil {
		t.Errorf(".github/ should survive in skip-fork mode: %v", err)
	}
}

// ──────────────────────────────────────────────
// gitInit seam tests (runner-level)
// ──────────────────────────────────────────────

func TestGitInit_SeamArgsCaptured(t *testing.T) {
	var captured []string
	stubRunCommandContext(t, func(_ context.Context, _ string, arg ...string) runner {
		captured = arg
		return &mockCmd{}
	})

	workdir := t.TempDir()
	if err := gitInit(context.Background(), workdir); err != nil {
		t.Fatalf("gitInit failed: %v", err)
	}
	if strings.Join(captured, " ") != "init "+workdir {
		t.Errorf("expected (git, init, workdir), got %v", captured)
	}
}

func TestGitInit_ErrorWrapsOutput(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{combinedFn: func() ([]byte, error) {
			return []byte("fatal: Invalid path"), fmt.Errorf("exit status 128")
		}}
	})

	err := gitInit(context.Background(), t.TempDir())
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "git init") {
		t.Errorf("error should mention git init: %v", err)
	}
	if !strings.Contains(err.Error(), "Invalid path") {
		t.Errorf("error should include command output: %v", err)
	}
}
