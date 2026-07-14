package main

import (
	"context"
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
	return auth, gh, clone, ext, env, probe, uid, gitID
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
	_, _, _, _, _, probe, _, _ := defaultMocks()

	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, "", t.TempDir(),
		nil, nil, nil, nil, nil, probe, nil, nil, mockConfirmFn(true, nil))
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
	_, _, _, _, _, probe, _, _ := defaultMocks()

	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, "", t.TempDir(),
		nil, nil, nil, nil, nil, probe, nil, nil, mockConfirmFn(true, nil))
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
	_, _, _, _, _, probe, _, _ := defaultMocks()

	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, "", t.TempDir(),
		nil, nil, nil, nil, nil, probe, nil, nil, mockConfirmFn(true, nil))
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
	_, _, _, _, _, probe, _, _ := defaultMocks()

	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, "", t.TempDir(),
		nil, nil, nil, nil, nil, probe, nil, nil, mockConfirmFn(true, nil))
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
	_, _, _, ext, env, probe, uid, gitID := defaultMocks()

	err := runInit(context.Background(), mockDocker, mockCfg, "sk-abc123", true, true, "", t.TempDir(),
		nil, nil, nil, ext, env, probe, uid, gitID, mockConfirmFn(true, nil))
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
	_, _, _, ext, env, probe, uid, gitID := defaultMocks()

	err := runInit(context.Background(), mockDocker, mockCfg, "sk-abc123", false, true, "", t.TempDir(),
		nil, nil, nil, ext, env, probe, uid, gitID, mockConfirmFn(true, nil))
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
	_, _, _, ext, env, probe, uid, gitID := defaultMocks()

	err := runInit(context.Background(), mockDocker, mockCfg, "sk-abc123", false, true, "", t.TempDir(),
		nil, nil, nil, ext, env, probe, uid, gitID, mockConfirmFn(true, nil))
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
	_, _, _, ext, env, probe, uid, gitID := defaultMocks()

	err := runInit(ctx, mockDocker, mockCfg, "sk-abc123", false, true, "", t.TempDir(),
		nil, nil, nil, ext, env, probe, uid, gitID, mockConfirmFn(true, nil))
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
	auth, gh, clone, ext, env, probe, uid, gitID := defaultMocks()

	workdir := t.TempDir()
	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, "owner/cheasee-pi", workdir,
		auth, gh, clone, ext, env, probe, uid, gitID, mockConfirmFn(true, nil))
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

	probe := &mockWorkingDirProbe{
		inspectFunc: func(path string) (WorkdirState, error) {
			return WorkdirEmpty, nil
		},
	}

	workdir := t.TempDir()
	err := runInit(context.Background(), mockDocker, mockCfg, "sk-abc123", false, true, "", workdir,
		nil, nil, nil, ext, env, probe, &mockUIDResolver{}, &mockGitIdentity{}, mockConfirmFn(true, nil))
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
	auth, err := runInitLegacy(context.Background(), &mockRepository{}, "sk-legacy-key")
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
	_, _, clone, ext, env, probe, uid, gitID := defaultMocks()

	// Use a mock authenticator that respects cancelled context
	mockAuth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return nil, ctx.Err()
		},
	}

	// Cancel right after docker check
	cancel()

	err := runInit(ctx, mockDocker, mockCfg, "", false, false, "", t.TempDir(),
		mockAuth, nil, clone, ext, env, probe, uid, gitID, mockConfirmFn(true, nil))
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
	_, _, clone, ext, env, probe, uid, gitID := defaultMocks()

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
	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, "owner/cheasee-pi", workdir,
		mockAuth, mockGH, clone, ext, env, probe, uid, gitID, mockConfirmFn(true, nil))
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
	_, _, clone, ext, env, probe, uid, gitID := defaultMocks()

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
	err := runInit(context.Background(), mockDocker, mockCfg, "", false, false, "owner/cheasee-pi", workdir,
		mockAuth, mockGH, clone, ext, env, probe, uid, gitID, mockConfirmFn(true, nil))
	if err == nil {
		t.Fatal("expected error for non-422 fork error")
	}
}

// ──────────────────────────────────────────────
// Submodule tests
// ──────────────────────────────────────────────

func TestRunInitSubmodule_Success(t *testing.T) {
	mockClone := &mockCloner{
		configureSubmodFunc: func(ctx context.Context, repoPath, submodulePath, newURL string) error {
			if submodulePath != "private-pi" {
				return fmt.Errorf("expected private-pi, got %s", submodulePath)
			}
			return nil
		},
	}

	err := mockClone.ConfigureSubmodule(context.Background(), t.TempDir(), "private-pi", "https://github.com/testuser/cheasee-pi.git")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRunInitSubmodule_NotExists(t *testing.T) {
	err := runInitSubmodule(context.Background(), &mockCloner{}, t.TempDir(), "https://github.com/testuser/cheasee-pi.git")
	if err != nil {
		t.Fatalf("expected no error for missing submodule: %v", err)
	}
}

func TestRunInitSubmodule_Fails(t *testing.T) {
	mockClone := &mockCloner{
		configureSubmodFunc: func(ctx context.Context, repoPath, submodulePath, newURL string) error {
			return fmt.Errorf("submodule update failed")
		},
	}

	err := runInitSubmodule(context.Background(), mockClone, t.TempDir(), "https://github.com/testuser/cheasee-pi.git")
	if err == nil {
		t.Fatal("expected error")
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
	expectedFlags := []string{"--workdir", "--source-repo", "--no-github", "--client-id"}
	for _, flag := range expectedFlags {
		if !strings.Contains(output, flag) {
			t.Errorf("init --help output should show %q flag", flag)
		}
	}
}
