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
)

// defaultMocks returns a set of working mock implementations for all new ports.
// Tests can override specific mocks as needed.
func defaultMocks() (
	*mockAuthenticator,
	*mockGitHubClient,
	*mockCloner,
	*mockExtractor,
	*mockEnvRenderer,
	*mockWorkingDirProbe,
	*mockUIDResolver,
	*mockGitIdentity,
	*mockSettingsScaffold,
	*mockGitInitializer,
) {
	auth := &mockAuthenticator{}
	gh := &mockGitHubClient{
		getUserFunc: func(ctx context.Context, token string) (string, error) {
			return "testuser", nil
		},
		createForkFunc: func(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error) {
			return "testuser/cheasee-pi", nil
		},
		waitForkFunc: func(ctx context.Context, token, owner, repo string) error {
			return nil
		},
	}
	clone := &mockCloner{}
	ext := &mockExtractor{}
	env := &mockEnvRenderer{}
	probe := &mockWorkingDirProbe{
		inspectFunc: func(path string) (WorkdirState, error) {
			return WorkdirEmpty, nil
		},
	}
	uid := &mockUIDResolver{}
	gitID := &mockGitIdentity{}
	scaffold := &mockSettingsScaffold{}
	gitInit := &mockGitInitializer{}
	return auth, gh, clone, ext, env, probe, uid, gitID, scaffold, gitInit
}

// ──────────────────────────────────────────────
// Phase 1: Docker check tests (legacy, preserved)
// ──────────────────────────────────────────────

func TestInitUseCase_DockerNotInstalled(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: false,
			Running:   false,
			Err:       fmt.Errorf("docker not found"),
		},
	}
	mockCfg := &mockRepository{}
	_, _, _, _, _, probe, _, _, _, _ := defaultMocks()

	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModePromptFork}, t.TempDir(),
		nil, nil, nil, nil, nil, probe, nil, nil, nil, nil, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
	if err == nil {
		t.Fatal("expected error when Docker not installed")
	}
	if !strings.Contains(err.Error(), "Docker is not installed") {
		t.Errorf("error should mention Docker is not installed: %v", err)
	}
	if mockCfg.saved {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerNotRunning(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: true,
			Running:   false,
			Err:       fmt.Errorf("Docker daemon not running"),
		},
	}
	mockCfg := &mockRepository{}
	_, _, _, _, _, probe, _, _, _, _ := defaultMocks()

	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModePromptFork}, t.TempDir(),
		nil, nil, nil, nil, nil, probe, nil, nil, nil, nil, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
	if err == nil {
		t.Fatal("expected error when Docker not running")
	}
	if !strings.Contains(err.Error(), "not running") {
		t.Errorf("error should mention Docker not running: %v", err)
	}
	if mockCfg.saved {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerVersionTooOld(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: true,
			Running:   true,
			Version:   "23.0.0",
			Err:       fmt.Errorf("Docker Engine 23.0.0 is too old, need >= 24.0.0"),
		},
	}
	mockCfg := &mockRepository{}
	_, _, _, _, _, probe, _, _, _, _ := defaultMocks()

	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModePromptFork}, t.TempDir(),
		nil, nil, nil, nil, nil, probe, nil, nil, nil, nil, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
	if err == nil {
		t.Fatal("expected error when Docker version too old")
	}
	if !strings.Contains(err.Error(), "Docker") {
		t.Errorf("error should mention Docker: %v", err)
	}
	if mockCfg.saved {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerCheckReturnsErr(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: true,
			Running:   true,
			Version:   "24.0.9",
			Err:       fmt.Errorf("version check failed"),
		},
	}
	mockCfg := &mockRepository{}
	_, _, _, _, _, probe, _, _, _, _ := defaultMocks()

	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModePromptFork}, t.TempDir(),
		nil, nil, nil, nil, nil, probe, nil, nil, nil, nil, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
	if err == nil {
		t.Fatal("expected error when Docker CheckResult.Err is set")
	}
}

func TestInitUseCase_NoDockerCheckFlag(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: false,
		},
	}
	mockCfg := &mockRepository{}
	_, _, _, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	err := runInit(context.Background(), mockDocker, mockCfg, "sk-abc123", true, true, SourceForkInput{Mode: ModePromptFork}, t.TempDir(),
		nil, nil, nil, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
	if err != nil {
		t.Fatalf("unexpected error with --no-docker-check: %v", err)
	}
	if !mockCfg.saved {
		t.Error("Save should be called when --no-docker-check is set")
	}
	if mockCfg.savedKey != "sk-abc123" {
		t.Errorf("expected saved key 'sk-abc123', got %q", mockCfg.savedKey)
	}
}

func TestInitUseCase_HappyPathWithAPIKeyFlag(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: true,
			Running:   true,
			Version:   "24.0.9",
		},
	}
	mockCfg := &mockRepository{}
	_, _, _, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	err := runInit(context.Background(), mockDocker, mockCfg, "sk-abc123", false, true, SourceForkInput{Mode: ModePromptFork}, t.TempDir(),
		nil, nil, nil, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
	if err != nil {
		t.Fatalf("unexpected error on happy path: %v", err)
	}
	if !mockCfg.saved {
		t.Error("Save should be called on happy path")
	}
	if mockCfg.savedKey != "sk-abc123" {
		t.Errorf("expected API key 'sk-abc123', got %q", mockCfg.savedKey)
	}
}

func TestInitUseCase_ConfigSaveError(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: true,
			Running:   true,
			Version:   "24.0.9",
		},
	}
	mockCfg := &mockRepository{saveErr: fmt.Errorf("disk full")}
	_, _, _, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	err := runInit(context.Background(), mockDocker, mockCfg, "sk-abc123", false, true, SourceForkInput{Mode: ModePromptFork}, t.TempDir(),
		nil, nil, nil, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
	if err == nil {
		t.Fatal("expected error when Save fails")
	}
	if !strings.Contains(err.Error(), "disk full") {
		t.Errorf("error should propagate Save error: %v", err)
	}
}

func TestInitUseCase_ContextCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled

	mockDocker := &mockCheckerCtx{orig: &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}}
	mockCfg := &mockRepository{}
	_, _, _, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	err := runInit(ctx, mockDocker, mockCfg, "sk-abc123", false, true, SourceForkInput{Mode: ModePromptFork}, t.TempDir(),
		nil, nil, nil, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
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
	probe := &mockWorkingDirProbe{
		inspectFunc: func(path string) (WorkdirState, error) {
			return WorkdirEmpty, nil
		},
	}
	proceed, err := runInitProbe(context.Background(), probe, t.TempDir(), mockConfirmFn(true, nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !proceed {
		t.Error("expected to proceed for empty dir")
	}
}

func TestInitProbe_Complete_UserAccepts(t *testing.T) {
	probe := &mockWorkingDirProbe{
		inspectFunc: func(path string) (WorkdirState, error) {
			return WorkdirComplete, nil
		},
	}
	proceed, err := runInitProbe(context.Background(), probe, t.TempDir(), mockConfirmFn(true, nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !proceed {
		t.Error("expected to proceed when user accepts")
	}
}

func TestInitProbe_Complete_UserDeclines(t *testing.T) {
	probe := &mockWorkingDirProbe{
		inspectFunc: func(path string) (WorkdirState, error) {
			return WorkdirComplete, nil
		},
	}
	proceed, err := runInitProbe(context.Background(), probe, t.TempDir(), mockConfirmFn(false, nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if proceed {
		t.Error("expected not to proceed when user declines")
	}
}

func TestInitProbe_HasRepo_UserAccepts(t *testing.T) {
	probe := &mockWorkingDirProbe{
		inspectFunc: func(path string) (WorkdirState, error) {
			return WorkdirHasRepo, nil
		},
	}
	proceed, err := runInitProbe(context.Background(), probe, t.TempDir(), mockConfirmFn(true, nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !proceed {
		t.Error("expected to proceed when user accepts")
	}
}

func TestInitProbe_HasCompose_UserAccepts(t *testing.T) {
	probe := &mockWorkingDirProbe{
		inspectFunc: func(path string) (WorkdirState, error) {
			return WorkdirHasCompose, nil
		},
	}
	proceed, err := runInitProbe(context.Background(), probe, t.TempDir(), mockConfirmFn(true, nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !proceed {
		t.Error("expected to proceed when user accepts")
	}
}

func TestInitProbe_HasRepo_UserDeclines(t *testing.T) {
	probe := &mockWorkingDirProbe{
		inspectFunc: func(path string) (WorkdirState, error) {
			return WorkdirHasRepo, nil
		},
	}
	proceed, err := runInitProbe(context.Background(), probe, t.TempDir(), mockConfirmFn(false, nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if proceed {
		t.Error("expected not to proceed when user declines")
	}
}

func TestInitProbe_Error(t *testing.T) {
	probe := &mockWorkingDirProbe{
		inspectFunc: func(path string) (WorkdirState, error) {
			return WorkdirEmpty, fmt.Errorf("permission denied")
		},
	}
	_, err := runInitProbe(context.Background(), probe, t.TempDir(), mockConfirmFn(true, nil))
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "permission denied") {
		t.Errorf("expected permission denied: %v", err)
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
	if token != "gho_test_token" {
		t.Errorf("expected gho_test_token, got %q", token)
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
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	auth, gh, clone, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	workdir := t.TempDir()
	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}, workdir,
		auth, gh, clone, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
	if err != nil {
		t.Fatalf("full flow failed: %v", err)
	}
	if !mockCfg.saved {
		t.Error("Save should be called after full flow")
	}
}

func TestRunInit_NoGitHubFlag(t *testing.T) {
	// --no-github flag: extract + env + save all run after auth
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}

	extractCalled := false
	ext := &mockExtractor{
		extractFunc: func(ctx context.Context, destDir string) error {
			extractCalled = true
			return nil
		},
	}

	renderCalled := false
	env := &mockEnvRenderer{
		renderFunc: func(ctx context.Context, dest string, vals EnvValues) error {
			renderCalled = true
			return nil
		},
	}

	scaffold := &mockSettingsScaffold{}
	gitInit := &mockGitInitializer{}

	probe := &mockWorkingDirProbe{
		inspectFunc: func(path string) (WorkdirState, error) {
			return WorkdirEmpty, nil
		},
	}

	workdir := t.TempDir()
	err := runInit(context.Background(), mockDocker, mockCfg, "sk-abc123", false, true, SourceForkInput{Mode: ModePromptFork}, workdir,
		nil, nil, nil, ext, env, probe, &mockUIDResolver{}, &mockGitIdentity{}, scaffold, gitInit, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
	if err != nil {
		t.Fatalf("legacy path should work: %v", err)
	}
	if !extractCalled {
		t.Error("Extract should be called on legacy path")
	}
	if !renderCalled {
		t.Error("Env render should be called on legacy path")
	}
	if !mockCfg.saved {
		t.Error("Save should be called on legacy path")
	}
	if mockCfg.savedKey != "sk-abc123" {
		t.Errorf("expected API key 'sk-abc123', got %q", mockCfg.savedKey)
	}
	if mockCfg.savedAuth == nil || mockCfg.savedAuth.RepoPath != workdir {
		t.Errorf("expected RepoPath %q, got %q", workdir, mockCfg.savedAuth.RepoPath)
	}
}

func TestRunInitLegacy_ReturnsAuth(t *testing.T) {
	// runInitLegacy is auth-only: returns *Auth, does NOT save/extract/render
	auth, err := runInitLegacy(context.Background(), &mockRepository{}, "sk-legacy-key", "opencode-go")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if auth.APIKey != "sk-legacy-key" {
		t.Errorf("expected API key 'sk-legacy-key', got %q", auth.APIKey)
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

	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	_, _, clone, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	// Use a mock authenticator that respects cancelled context
	mockAuth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return nil, ctx.Err()
		},
	}

	// Cancel right after docker check
	cancel()

	err := runInit(ctx, mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModePromptFork}, t.TempDir(),
		mockAuth, nil, clone, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
}

// ──────────────────────────────────────────────
// Fork already exists test
// ──────────────────────────────────────────────

func TestRunInit_ForkAlreadyExists(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	_, _, clone, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	// Override GitHub client to return fork-already-exists
	mockGH := &mockGitHubClient{
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
	mockAuth := &mockAuthenticator{}

	workdir := t.TempDir()
	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}, workdir,
		mockAuth, mockGH, clone, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
	if err != nil {
		t.Fatalf("fork-already-exists should not be fatal: %v", err)
	}
}

// ──────────────────────────────────────────────
// Fork non-422 error test
// ──────────────────────────────────────────────

func TestRunInit_ForkNon422Error(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	_, _, clone, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	mockGH := &mockGitHubClient{
		getUserFunc: func(ctx context.Context, token string) (string, error) {
			return "testuser", nil
		},
		createForkFunc: func(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error) {
			return "", fmt.Errorf("forbidden")
		},
	}
	mockAuth := &mockAuthenticator{}

	workdir := t.TempDir()
	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}, workdir,
		mockAuth, mockGH, clone, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
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
	mc := &mockCloner{}
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
	mc := &mockCloner{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]Submodule, error) {
			return []Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
				{Name: "private-pi", Path: "private-pi", URL: "https://github.com/SchneiderDaniel/private-pi.git"},
			}, nil
		},
	}

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
	mc := &mockCloner{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]Submodule, error) {
			return []Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
			}, nil
		},
	}

	promptFn := func(sms []Submodule) (map[string]string, error) {
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
	mc := &mockCloner{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]Submodule, error) {
			return []Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
				{Name: "private-pi", Path: "private-pi", URL: "https://github.com/SchneiderDaniel/private-pi.git"},
			}, nil
		},
	}

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
	mc := &mockCloner{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]Submodule, error) {
			return []Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
				{Name: "private-pi", Path: "private-pi", URL: "https://github.com/SchneiderDaniel/private-pi.git"},
			}, nil
		},
		setSubmoduleURLFunc: func(ctx context.Context, repoPath, name, url string) error {
			return nil
		},
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
	mc := &mockCloner{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]Submodule, error) {
			return []Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
				{Name: "private-pi", Path: "private-pi", URL: "https://github.com/SchneiderDaniel/private-pi.git"},
			}, nil
		},
	}

	promptFn := func(sms []Submodule) (map[string]string, error) {
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
	mc := &mockCloner{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]Submodule, error) {
			return []Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
			}, nil
		},
	}

	// Prompt returns one URL, but override wins
	promptFn := func(sms []Submodule) (map[string]string, error) {
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
	mc := &mockCloner{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]Submodule, error) {
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
	mc := &mockCloner{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]Submodule, error) {
			return []Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
			}, nil
		},
		setSubmoduleURLFunc: func(ctx context.Context, repoPath, name, url string) error {
			return fmt.Errorf("invalid URL")
		},
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
	mc := &mockCloner{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]Submodule, error) {
			return []Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
			}, nil
		},
		initAndUpdateSubmodFunc: func(ctx context.Context, repoPath string) error {
			return fmt.Errorf("update failed")
		},
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
	mc := &mockCloner{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]Submodule, error) {
			return []Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
			}, nil
		},
	}

	promptFn := func(sms []Submodule) (map[string]string, error) {
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

	mc := &mockCloner{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]Submodule, error) {
			return nil, ctx.Err()
		},
	}

	err := runInitSubmodule(ctx, mc, t.TempDir(), nil, false, nil, false, nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestRunInitSubmodule_EmptySubmoduleList(t *testing.T) {
	mc := &mockCloner{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]Submodule, error) {
			return []Submodule{}, nil
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
	mc := &mockCloner{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]Submodule, error) {
			return []Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
			}, nil
		},
		setSubmoduleURLFunc: func(ctx context.Context, repoPath, name, url string) error {
			return fmt.Errorf("submodule %q not found in .gitmodules", name)
		},
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
	extractedDir := ""
	mockExt := &mockExtractor{
		extractFunc: func(ctx context.Context, destDir string) error {
			extractedDir = destDir
			return nil
		},
	}

	dir := t.TempDir()
	err := runInitExtract(context.Background(), mockExt, dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if extractedDir != dir {
		t.Errorf("expected extract dir %q, got %q", dir, extractedDir)
	}
}

func TestRunInitExtract_Fails(t *testing.T) {
	mockExt := &mockExtractor{
		extractFunc: func(ctx context.Context, destDir string) error {
			return fmt.Errorf("disk full")
		},
	}

	err := runInitExtract(context.Background(), mockExt, t.TempDir())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestRunInitExtract_LogMessage(t *testing.T) {
	// Capture stderr to verify the log message includes /docker suffix
	oldStderr := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stderr = w
	defer func() {
		w.Close()
		os.Stderr = oldStderr
	}()

	mockExt := &mockExtractor{}
	dir := t.TempDir()
	if err := runInitExtract(context.Background(), mockExt, dir); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	w.Close()
	os.Stderr = oldStderr

	var buf bytes.Buffer
	if _, err := buf.ReadFrom(r); err != nil {
		t.Fatalf("read stderr: %v", err)
	}
	output := buf.String()

	// Should contain the /docker suffix on the workdir path
	expectedSuffix := dir + "/docker"
	if !strings.Contains(output, expectedSuffix) {
		t.Errorf("log message should contain %q, got: %s", expectedSuffix, output)
	}
	if !strings.Contains(output, "Compose files extracted to") {
		t.Errorf("log message should mention extraction, got: %s", output)
	}
}

// ──────────────────────────────────────────────
// Env generation tests
// ──────────────────────────────────────────────

func TestRunInitEnv_Success(t *testing.T) {
	mockEnv := &mockEnvRenderer{
		renderFunc: func(ctx context.Context, dest string, vals EnvValues) error {
			if vals.HostUID != "1000" {
				t.Errorf("expected uid 1000, got %q", vals.HostUID)
			}
			return nil
		},
	}

	workdir := t.TempDir()
	err := runInitEnv(context.Background(), mockEnv, &mockUIDResolver{}, &mockGitIdentity{}, workdir, mockConfirmFn(false, nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRunInitEnv_UIDFallback(t *testing.T) {
	mockEnv := &mockEnvRenderer{}
	uidResolver := &mockUIDResolver{
		currentFunc: func() (uid, gid string, err error) {
			return "", "", fmt.Errorf("no user")
		},
	}

	err := runInitEnv(context.Background(), mockEnv, uidResolver, &mockGitIdentity{}, t.TempDir(), mockConfirmFn(false, nil))
	if err == nil {
		t.Fatal("expected error when UID resolution fails")
	}
}

func TestRunInitEnv_GitIdentityFallback(t *testing.T) {
	gitIdentity := &mockGitIdentity{
		lookupFunc: func() (name, email string, err error) {
			return "", "", nil // empty identity, not an error
		},
	}

	var renderCalled bool
	mockEnv := &mockEnvRenderer{
		renderFunc: func(ctx context.Context, dest string, vals EnvValues) error {
			renderCalled = true
			if vals.GitName == "" {
				t.Error("expected non-empty GitName")
			}
			if vals.GitEmail == "" {
				t.Error("expected non-empty GitEmail")
			}
			return nil
		},
	}

	err := runInitEnv(context.Background(), mockEnv, &mockUIDResolver{}, gitIdentity, t.TempDir(), mockConfirmFn(false, nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !renderCalled {
		t.Error("Render should have been called")
	}
}

func TestRunInitEnv_AllFallbacksFail(t *testing.T) {
	uidResolver := &mockUIDResolver{
		currentFunc: func() (uid, gid string, err error) {
			return "", "", fmt.Errorf("all methods failed")
		},
	}

	err := runInitEnv(context.Background(), &mockEnvRenderer{}, uidResolver, &mockGitIdentity{}, t.TempDir(), mockConfirmFn(false, nil))
	if err == nil {
		t.Fatal("expected error when all UID fallbacks fail")
	}
}

// ──────────────────────────────────────────────
// Success message test
// ──────────────────────────────────────────────

func TestInit_SuccessMessage(t *testing.T) {
	// Capture stderr to verify the success message
	oldStderr := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stderr = w

	// Restore after test
	defer func() {
		w.Close()
		os.Stderr = oldStderr
	}()

	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	_, _, _, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	err = runInit(context.Background(), mockDocker, mockCfg, "sk-abc123", false, true, SourceForkInput{Mode: ModePromptFork}, t.TempDir(),
		nil, nil, nil, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	w.Close()
	os.Stderr = oldStderr

	var buf bytes.Buffer
	_, err = buf.ReadFrom(r)
	if err != nil {
		t.Fatalf("read stderr: %v", err)
	}
	output := buf.String()

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
		APIKey:   "sk-abc",
		Provider: "opencode-go",
	}

	data, err := json.Marshal(auth)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

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
	if entry["key"] != "sk-abc" {
		t.Errorf("expected key 'sk-abc', got %v", entry["key"])
	}

	// Must NOT have flat api_key field
	if _, ok := raw["api_key"]; ok {
		t.Error("expected no flat 'api_key' field when Provider is set")
	}
}

func TestAuthPerProvider_MarshalNoProviderWritesFlat(t *testing.T) {
	auth := &Auth{
		APIKey: "sk-abc",
		// Provider is empty — should write flat api_key
	}

	data, err := json.Marshal(auth)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal of output failed: %v", err)
	}

	if _, ok := raw["api_key"]; !ok {
		t.Error("expected flat 'api_key' field when Provider is empty")
	}
	if raw["api_key"] != "sk-abc" {
		t.Errorf("expected api_key 'sk-abc', got %v", raw["api_key"])
	}
}

func TestAuthPerProvider_MarshalEmptyProviderNoKey(t *testing.T) {
	// GitHub-only auth: no Provider, no APIKey
	// When Provider is empty, api_key is always written at top level for
	// backward compatibility (even if empty string), preserving the
	// pre-existing TestConfigSave_EmptyAPIKey contract.
	auth := &Auth{
		GitHubToken: "gho_token",
		GitHubUser:  "testuser",
		RepoPath:    "/workspace",
	}

	data, err := json.Marshal(auth)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

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
	if raw["github_token"] != "gho_token" {
		t.Errorf("expected github_token 'gho_token', got %v", raw["github_token"])
	}
}

func TestAuthPerProvider_UnmarshalProviderFormat(t *testing.T) {
	data := []byte(`{
		"opencode-go": {"key": "sk-abc"},
		"github_token": "gho_123",
		"github_user": "testuser",
		"repo_path": "/workspace"
	}`)

	var auth Auth
	if err := json.Unmarshal(data, &auth); err != nil {
		t.Fatalf("Unmarshal of provider format failed: %v", err)
	}

	if auth.APIKey != "sk-abc" {
		t.Errorf("expected APIKey 'sk-abc', got %q", auth.APIKey)
	}
	if auth.Provider != "opencode-go" {
		t.Errorf("expected Provider 'opencode-go', got %q", auth.Provider)
	}
	if auth.GitHubToken != "gho_123" {
		t.Errorf("expected GitHubToken 'gho_123', got %q", auth.GitHubToken)
	}
	if auth.GitHubUser != "testuser" {
		t.Errorf("expected GitHubUser 'testuser', got %q", auth.GitHubUser)
	}
	if auth.RepoPath != "/workspace" {
		t.Errorf("expected RepoPath '/workspace', got %q", auth.RepoPath)
	}
}

func TestAuthPerProvider_UnmarshalFlatFormat(t *testing.T) {
	data := []byte(`{"api_key": "sk-old", "github_token": "gho_old"}`)

	var auth Auth
	if err := json.Unmarshal(data, &auth); err != nil {
		t.Fatalf("Unmarshal of flat format failed: %v", err)
	}

	if auth.APIKey != "sk-old" {
		t.Errorf("expected APIKey 'sk-old', got %q", auth.APIKey)
	}
	if auth.Provider != "" {
		t.Errorf("expected empty Provider for flat format, got %q", auth.Provider)
	}
	if auth.GitHubToken != "gho_old" {
		t.Errorf("expected GitHubToken 'gho_old', got %q", auth.GitHubToken)
	}
}

func TestAuthPerProvider_SaveWritesJqParseableOutput(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

	cfg := NewRepository()
	auth := &Auth{
		APIKey:   "sk-jq-test",
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
	if entryMap["key"] != "sk-jq-test" {
		t.Errorf("expected key 'sk-jq-test', got %v", entryMap["key"])
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
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

	cfg := NewRepository()
	auth := &Auth{
		APIKey:      "sk-abc",
		Provider:    "opencode-go",
		GitHubToken: "gho_token",
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
	if loaded.APIKey != "sk-abc" {
		t.Errorf("expected api_key 'sk-abc', got %q", loaded.APIKey)
	}
	if loaded.Provider != "opencode-go" {
		t.Errorf("expected Provider 'opencode-go', got %q", loaded.Provider)
	}
	if loaded.GitHubToken != "gho_token" {
		t.Errorf("expected GitHubToken 'gho_token', got %q", loaded.GitHubToken)
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
		APIKey:   "sk-abc",
		Provider: "openai",
	}

	data, err := json.Marshal(auth)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

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
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

	// Write old-format auth.json
	oldDir := filepath.Join(dir, "cheasee-pi")
	os.MkdirAll(oldDir, 0700)
	oldPath := filepath.Join(oldDir, "auth.json")
	oldContent := `{"api_key": "sk-old-key"}`
	os.WriteFile(oldPath, []byte(oldContent), 0600)

	cfg := NewRepository()
	auth, err := cfg.Load(context.Background())
	if err != nil {
		t.Fatalf("Load of old format failed: %v", err)
	}
	if auth.APIKey != "sk-old-key" {
		t.Errorf("expected API key 'sk-old-key', got %q", auth.APIKey)
	}
	if auth.GitHubToken != "" {
		t.Errorf("expected empty GitHubToken for old format, got %q", auth.GitHubToken)
	}
}

func TestConfigBackwardCompat_RoundTripPreservesNewFields(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

	cfg := NewRepository()
	auth := &Auth{
		APIKey:      "sk-abc",
		GitHubToken: "gho_token",
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
	if loaded.APIKey != "sk-abc" {
		t.Errorf("expected api_key 'sk-abc', got %q", loaded.APIKey)
	}
	if loaded.GitHubToken != "gho_token" {
		t.Errorf("expected GitHubToken 'gho_token', got %q", loaded.GitHubToken)
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
	rootCmd.SetArgs([]string{"init", "--help"})
	var buf strings.Builder
	rootCmd.SetOut(&buf)
	rootCmd.SetErr(&buf)

	_, err := rootCmd.ExecuteC()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	output := buf.String()
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
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	auth, gh, clone, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	workdir := t.TempDir()
	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModeSkipFork}, workdir,
		auth, gh, clone, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
	if err != nil {
		t.Fatalf("skip-fork flow failed: %v", err)
	}
	if !mockCfg.saved {
		t.Error("Save should be called after skip-fork flow")
	}
}

func TestRunInit_ForkURL(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}

	cloneCalled := false
	submoduleInited := false
	clone := &mockCloner{
		cloneWorktreeFunc: func(ctx context.Context, token, repoURL, workdir string) error {
			cloneCalled = true
			if repoURL != "https://github.com/user/existing-fork.git" {
				t.Errorf("expected clone URL 'https://github.com/user/existing-fork.git', got %q", repoURL)
			}
			return nil
		},
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]Submodule, error) {
			return []Submodule{{Name: "pi", URL: "https://github.com/SchneiderDaniel/pi.git"}}, nil
		},
		initAndUpdateSubmodFunc: func(ctx context.Context, repoPath string) error {
			submoduleInited = true
			return nil
		},
	}

	auth, gh, _, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	workdir := t.TempDir()
	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModeUseForkURL, ForkURL: "https://github.com/user/existing-fork.git"}, workdir,
		auth, gh, clone, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
	if err != nil {
		t.Fatalf("fork-url flow failed: %v", err)
	}
	if !cloneCalled {
		t.Error("Clone should be called with fork URL")
	}
	if !submoduleInited {
		t.Error("Submodule init should be called with fork URL")
	}
	if !mockCfg.saved {
		t.Error("Save should be called after fork-url flow")
	}
}

func TestRunInit_ForkURLSkipsCreateFork(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}

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

	clone := &mockCloner{
		cloneFunc: func(ctx context.Context, token, repoURL, destPath string) error {
			return nil
		},
		setSubmoduleURLFunc: func(ctx context.Context, repoPath, name, newURL string) error {
			return nil
		},
	}

	mockAuth := &mockAuthenticator{}
	_, _, _, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	workdir := t.TempDir()
	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModeUseForkURL, ForkURL: "https://github.com/user/existing-fork.git"}, workdir,
		mockAuth, mockGH, clone, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
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
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	auth, gh, clone, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	workdir := t.TempDir()
	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModeUseForkURL, ForkURL: ""}, workdir,
		auth, gh, clone, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(true, nil), mockInputFn("", nil), true, nil, false, nil)
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
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	auth, gh, clone, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	workdir := t.TempDir()
	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}, workdir,
		auth, gh, clone, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(true, nil, "Configure API keys"), mockInputFn("", nil), false, nil, false, nil)
	if err != nil {
		t.Fatalf("post-clone confirm flow failed: %v", err)
	}
	if !mockCfg.saved {
		t.Error("Save should be called when confirm is accepted")
	}
}

func TestRunInit_PostCloneConfirm_Declined(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	auth, gh, clone, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	workdir := t.TempDir()
	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}, workdir,
		auth, gh, clone, ext, env, probe, uid, gitID, scaffold, gitInit, mockConfirmFn(false, nil), mockInputFn("", nil), false, nil, false, nil)
	if err != nil {
		t.Fatalf("expected nil error (clean exit) when confirm is declined: %v", err)
	}
	if mockCfg.saved {
		t.Error("Save should NOT be called when confirm is declined")
	}
}

func TestRunInit_PostCloneConfirm_NoInputSkipsPrompt(t *testing.T) {
	// With noInput=true, the post-clone confirm should be skipped
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	auth, gh, clone, ext, env, probe, uid, gitID, scaffold, gitInit := defaultMocks()

	// If confirm were called with false, we'd error (but it won't be called)
	workdir := t.TempDir()
	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}, workdir,
		auth, gh, clone, ext, env, probe, uid, gitID, scaffold, gitInit, nil, mockInputFn("", nil), true, nil, false, nil)
	if err != nil {
		t.Fatalf("post-clone confirm with noInput=true failed: %v", err)
	}
	if !mockCfg.saved {
		t.Error("Save should be called when noInput skips prompt")
	}
}
// ──────────────────────────────────────────────
// Phase 1: Settings scaffold renderer (entity)
// ──────────────────────────────────────────────

func TestSettingsScaffold_WritesCorrectContent(t *testing.T) {
	scaffold := NewSettingsScaffold()
	workdir := t.TempDir()

	vals := TemplateSettingsValues{
		Provider: "opencode-go",
		GitName:  "Test User",
		GitEmail: "test@example.com",
		Memory:   "4G",
		CPUs:     "4.0",
	}

	if err := scaffold.Scaffold(context.Background(), workdir, vals); err != nil {
		t.Fatalf("Scaffold failed: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(workdir, ".pi", "settings.json"))
	if err != nil {
		t.Fatalf("Read settings.json failed: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("settings.json is not valid JSON: %v", err)
	}

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
	scaffold := NewSettingsScaffold()
	workdir := t.TempDir()

	vals := TemplateSettingsValues{
		Provider: "opencode-go",
		GitName:  "Original",
		GitEmail: "orig@example.com",
		Memory:   "2G",
		CPUs:     "2.0",
	}

	// First call: write file
	if err := scaffold.Scaffold(context.Background(), workdir, vals); err != nil {
		t.Fatalf("first Scaffold failed: %v", err)
	}

	// Second call: should no-op (file exists)
	vals2 := TemplateSettingsValues{
		Provider: "overwrite",
		GitName:  "Overwrite",
		GitEmail: "overwrite@example.com",
		Memory:   "8G",
		CPUs:     "8.0",
	}
	if err := scaffold.Scaffold(context.Background(), workdir, vals2); err != nil {
		t.Fatalf("second Scaffold failed: %v", err)
	}

	// Content must still be from first call (unchanged)
	data, err := os.ReadFile(filepath.Join(workdir, ".pi", "settings.json"))
	if err != nil {
		t.Fatalf("Read settings.json failed: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("settings.json is not valid JSON: %v", err)
	}

	if raw["defaultProvider"] != "opencode-go" {
		t.Errorf("expected defaultProvider 'opencode-go' (unchanged), got %v", raw["defaultProvider"])
	}
}

func TestSettingsScaffold_EmptyValues(t *testing.T) {
	scaffold := NewSettingsScaffold()
	workdir := t.TempDir()

	vals := TemplateSettingsValues{} // all empty

	if err := scaffold.Scaffold(context.Background(), workdir, vals); err != nil {
		t.Fatalf("Scaffold failed: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(workdir, ".pi", "settings.json"))
	if err != nil {
		t.Fatalf("Read settings.json failed: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("settings.json is not valid JSON: %v", err)
	}

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

	// Non-existent parent path should fail with mkdir error
	err := scaffold.Scaffold(context.Background(), "/nonexistent/path/to/workdir", vals)
	if err == nil {
		t.Fatal("expected error for invalid workdir")
	}
	if !strings.Contains(err.Error(), ".pi") && !strings.Contains(err.Error(), "mkdir") {
		t.Errorf("error should mention .pi directory or mkdir: %v", err)
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
	gitInit := NewGitInitializer()
	workdir := t.TempDir()

	if err := gitInit.Init(context.Background(), workdir); err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	// .git directory should exist
	gitDir := filepath.Join(workdir, ".git")
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		t.Error("expected .git directory to exist after Init")
	}
}

func TestGitInitializer_Idempotent(t *testing.T) {
	gitInit := NewGitInitializer()
	workdir := t.TempDir()

	// First call: create .git
	if err := gitInit.Init(context.Background(), workdir); err != nil {
		t.Fatalf("first Init failed: %v", err)
	}

	// Second call: should no-op
	if err := gitInit.Init(context.Background(), workdir); err != nil {
		t.Fatalf("second Init should not error: %v", err)
	}

	// .git still exists
	gitDir := filepath.Join(workdir, ".git")
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		t.Error("expected .git directory to exist after idempotent Init")
	}
}

func TestGitInitializer_NonExistentWorkdir(t *testing.T) {
	gitInit := NewGitInitializer()

	err := gitInit.Init(context.Background(), "/nonexistent/path/to/nowhere")
	if err == nil {
		t.Fatal("expected error for non-existent workdir")
	}
	if !strings.Contains(err.Error(), "git init") {
		t.Errorf("error should mention 'git init': %v", err)
	}
}

func TestGitInitializer_ContextCancelled(t *testing.T) {
	gitInit := NewGitInitializer()
	workdir := t.TempDir()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled

	err := gitInit.Init(ctx, workdir)
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