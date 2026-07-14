package main

import (
	"context"

	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
)

// ──────────────────────────────────────────────
// Mock: Docker
// ──────────────────────────────────────────────

// mockDockerChecker simulates Docker check results without real Docker.
type mockDockerChecker struct {
	result *CheckResult
	err    error
}

func (m *mockDockerChecker) Check(_ context.Context) (*CheckResult, error) {
	return m.result, m.err
}

// mockCheckerCtx wraps a Checker but returns context.Canceled when context is done.
type mockCheckerCtx struct {
	orig Checker
}

func (m *mockCheckerCtx) Check(ctx context.Context) (*CheckResult, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		return m.orig.Check(ctx)
	}
}

// ──────────────────────────────────────────────
// Mock: Repository
// ──────────────────────────────────────────────

// mockRepository implements Repository for testing.
type mockRepository struct {
	saved    bool
	savedKey string
	saveErr  error
	loadErr  error
	loadAuth *Auth
	path     string
}

func (m *mockRepository) Load(_ context.Context) (*Auth, error) {
	if m.loadErr != nil {
		return nil, m.loadErr
	}
	if m.loadAuth != nil {
		return m.loadAuth, nil
	}
	return &Auth{}, nil
}

func (m *mockRepository) Save(_ context.Context, auth *Auth) error {
	if m.saveErr != nil {
		return m.saveErr
	}
	m.saved = true
	m.savedKey = auth.APIKey
	return nil
}

func (m *mockRepository) Path() (string, error) {
	if m.path != "" {
		return m.path, nil
	}
	return "/mock/path/auth.json", nil
}

// ──────────────────────────────────────────────
// Mock: Authenticator
// ──────────────────────────────────────────────

type mockAuthenticator struct {
	requestCodeFunc func(ctx context.Context, scopes []string) (*device.CodeResponse, error)
	waitFunc        func(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error)
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
	return &api.AccessToken{Token: "gho_test_token"}, nil
}

// ──────────────────────────────────────────────
// Mock: GitHubClient
// ──────────────────────────────────────────────

type mockGitHubClient struct {
	getUserFunc    func(ctx context.Context, token string) (string, error)
	createForkFunc func(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error)
	waitForkFunc   func(ctx context.Context, token, owner, repo string) error
}

func (m *mockGitHubClient) GetAuthenticatedUser(ctx context.Context, token string) (string, error) {
	if m.getUserFunc != nil {
		return m.getUserFunc(ctx, token)
	}
	return "testuser", nil
}

func (m *mockGitHubClient) CreateFork(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error) {
	if m.createForkFunc != nil {
		return m.createForkFunc(ctx, token, sourceOwner, sourceRepo)
	}
	return "testuser/cheasee-pi", nil
}

func (m *mockGitHubClient) WaitForkReady(ctx context.Context, token, owner, repo string) error {
	if m.waitForkFunc != nil {
		return m.waitForkFunc(ctx, token, owner, repo)
	}
	return nil
}

// ──────────────────────────────────────────────
// Mock: Cloner
// ──────────────────────────────────────────────

type mockCloner struct {
	cloneFunc           func(ctx context.Context, token, repoURL, destPath string) error
	configureSubmodFunc func(ctx context.Context, repoPath, submodulePath, newURL string) error
}

func (m *mockCloner) Clone(ctx context.Context, token, repoURL, destPath string) error {
	if m.cloneFunc != nil {
		return m.cloneFunc(ctx, token, repoURL, destPath)
	}
	return nil
}

func (m *mockCloner) ConfigureSubmodule(ctx context.Context, repoPath, submodulePath, newURL string) error {
	if m.configureSubmodFunc != nil {
		return m.configureSubmodFunc(ctx, repoPath, submodulePath, newURL)
	}
	return nil
}

// ──────────────────────────────────────────────
// Mock: Extractor
// ──────────────────────────────────────────────

type mockExtractor struct {
	extractFunc func(ctx context.Context, destDir string) error
}

func (m *mockExtractor) Extract(ctx context.Context, destDir string) error {
	if m.extractFunc != nil {
		return m.extractFunc(ctx, destDir)
	}
	return nil
}

// ──────────────────────────────────────────────
// Mock: EnvRenderer
// ──────────────────────────────────────────────

type mockEnvRenderer struct {
	renderFunc func(ctx context.Context, dest string, vals EnvValues) error
}

func (m *mockEnvRenderer) Render(ctx context.Context, dest string, vals EnvValues) error {
	if m.renderFunc != nil {
		return m.renderFunc(ctx, dest, vals)
	}
	return nil
}

// ──────────────────────────────────────────────
// Mock: WorkingDirProbe
// ──────────────────────────────────────────────

type mockWorkingDirProbe struct {
	inspectFunc func(path string) (WorkdirState, error)
}

func (m *mockWorkingDirProbe) Inspect(path string) (WorkdirState, error) {
	if m.inspectFunc != nil {
		return m.inspectFunc(path)
	}
	return WorkdirEmpty, nil
}

// ──────────────────────────────────────────────
// Mock: UIDResolver
// ──────────────────────────────────────────────

type mockUIDResolver struct {
	currentFunc func() (uid, gid string, err error)
}

func (m *mockUIDResolver) Current() (uid, gid string, err error) {
	if m.currentFunc != nil {
		return m.currentFunc()
	}
	return "1000", "1000", nil
}

// ──────────────────────────────────────────────
// Mock: GitIdentity
// ──────────────────────────────────────────────

type mockGitIdentity struct {
	lookupFunc func() (name, email string, err error)
}

func (m *mockGitIdentity) Lookup() (name, email string, err error) {
	if m.lookupFunc != nil {
		return m.lookupFunc()
	}
	return "Test User", "test@example.com", nil
}

// ──────────────────────────────────────────────
// Mock: ConfirmFn
// ──────────────────────────────────────────────

// mockConfirmFn returns a confirm function that returns the given result.
func mockConfirmFn(result bool, err error) func(string) (bool, error) {
	return func(title string) (bool, error) {
		return result, err
	}
}

// ──────────────────────────────────────────────
// Compile-time interface checks
// ──────────────────────────────────────────────

var (
	_ Checker          = (*mockDockerChecker)(nil)
	_ Checker          = (*mockCheckerCtx)(nil)
	_ Repository       = (*mockRepository)(nil)
	_ Authenticator    = (*mockAuthenticator)(nil)
	_ GitHubClient     = (*mockGitHubClient)(nil)
	_ Cloner           = (*mockCloner)(nil)
	_ Extractor        = (*mockExtractor)(nil)
	_ EnvRenderer      = (*mockEnvRenderer)(nil)
	_ WorkingDirProbe  = (*mockWorkingDirProbe)(nil)
	_ UIDResolver      = (*mockUIDResolver)(nil)
	_ GitIdentity      = (*mockGitIdentity)(nil)
)
