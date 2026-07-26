package main

import (
	"context"
	"os"
	"strings"

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
	saved          bool
	savedKey       string
	savedProvider  string
	savedAuth      *Auth
	saveErr        error
	loadErr        error
	loadAuth       *Auth
	path           string
	providers      map[string]string // returned by ListProviders
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
	m.savedProvider = auth.Provider
	m.savedAuth = auth
	return nil
}

func (m *mockRepository) Path() (string, error) {
	if m.path != "" {
		return m.path, nil
	}
	return "/mock/path/auth.json", nil
}

func (m *mockRepository) AddProvider(_ context.Context, provider, key string) error {
	m.savedProvider = provider
	m.savedKey = key
	return nil
}

func (m *mockRepository) RemoveProvider(_ context.Context, provider string) error {
	return nil
}

func (m *mockRepository) ListProviders(_ context.Context) (map[string]string, error) {
	if m.providers != nil {
		return m.providers, nil
	}
	return nil, nil
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
	cloneFunc                func(ctx context.Context, token, repoURL, destPath string) error
	cloneWorktreeFunc        func(ctx context.Context, token, repoURL, workdir string) error
	listSubmodulesFunc       func(ctx context.Context, repoPath string) ([]Submodule, error)
	setSubmoduleURLFunc      func(ctx context.Context, repoPath, name, newURL string) error
	initAndUpdateSubmodFunc  func(ctx context.Context, repoPath string) error
	addSubmoduleFunc         func(ctx context.Context, repoPath, name, url string) error

	// Tracking fields for test assertions
	listSubmodulesCalled    bool
	setSubmoduleURLCalled   bool
	setSubmoduleURLName     string
	setSubmoduleURLURL      string
	setSubmoduleURLCalls    []struct{ Name, URL string }
	initAndUpdateCalled     bool
	addSubmoduleCalls       []struct{ Name, URL string }
}

func (m *mockCloner) Clone(ctx context.Context, token, repoURL, destPath string) error {
	if m.cloneFunc != nil {
		return m.cloneFunc(ctx, token, repoURL, destPath)
	}
	return nil
}

func (m *mockCloner) CloneWorktree(ctx context.Context, token, repoURL, workdir string) error {
	if m.cloneWorktreeFunc != nil {
		return m.cloneWorktreeFunc(ctx, token, repoURL, workdir)
	}
	// Create the workdir so tests that check for it pass
	os.MkdirAll(workdir, 0755)
	return nil
}

func (m *mockCloner) ListSubmodules(ctx context.Context, repoPath string) ([]Submodule, error) {
	m.listSubmodulesCalled = true
	if m.listSubmodulesFunc != nil {
		return m.listSubmodulesFunc(ctx, repoPath)
	}
	return nil, nil
}

func (m *mockCloner) SetSubmoduleURL(ctx context.Context, repoPath, name, newURL string) error {
	m.setSubmoduleURLCalled = true
	m.setSubmoduleURLName = name
	m.setSubmoduleURLURL = newURL
	m.setSubmoduleURLCalls = append(m.setSubmoduleURLCalls, struct{ Name, URL string }{name, newURL})
	if m.setSubmoduleURLFunc != nil {
		return m.setSubmoduleURLFunc(ctx, repoPath, name, newURL)
	}
	return nil
}

func (m *mockCloner) InitAndUpdateSubmodules(ctx context.Context, repoPath string) error {
	m.initAndUpdateCalled = true
	if m.initAndUpdateSubmodFunc != nil {
		return m.initAndUpdateSubmodFunc(ctx, repoPath)
	}
	return nil
}

func (m *mockCloner) AddSubmodule(ctx context.Context, repoPath, name, url string) error {
	m.addSubmoduleCalls = append(m.addSubmoduleCalls, struct{ Name, URL string }{name, url})
	if m.addSubmoduleFunc != nil {
		return m.addSubmoduleFunc(ctx, repoPath, name, url)
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
// Mock: SettingsScaffold
// ──────────────────────────────────────────────

type mockSettingsScaffold struct {
	scaffoldFunc func(ctx context.Context, workdir string, vals TemplateSettingsValues) error
}

func (m *mockSettingsScaffold) Scaffold(ctx context.Context, workdir string, vals TemplateSettingsValues) error {
	if m.scaffoldFunc != nil {
		return m.scaffoldFunc(ctx, workdir, vals)
	}
	return nil
}

// ──────────────────────────────────────────────
// Mock: GitInitializer
// ──────────────────────────────────────────────

type mockGitInitializer struct {
	initFunc func(ctx context.Context, workdir string) error
}

func (m *mockGitInitializer) Init(ctx context.Context, workdir string) error {
	if m.initFunc != nil {
		return m.initFunc(ctx, workdir)
	}
	return nil
}

// ──────────────────────────────────────────────
// Mock: InitRemover
// ──────────────────────────────────────────────

type mockInitRemover struct {
	removeFunc func(workdir string) error
	called     bool
	calledWith string
}

func (m *mockInitRemover) Remove(workdir string) error {
	m.called = true
	m.calledWith = workdir
	if m.removeFunc != nil {
		return m.removeFunc(workdir)
	}
	return nil
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
	_ SettingsScaffold = (*mockSettingsScaffold)(nil)
	_ GitInitializer   = (*mockGitInitializer)(nil)
	_ InitRemover      = (*mockInitRemover)(nil)
)
