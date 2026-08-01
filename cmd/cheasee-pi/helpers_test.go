package main

import (
	"context"
	"strings"

	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
)

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
// Mock: submoduleOps (go-git submodule ops)
// ──────────────────────────────────────────────

type mockSubmoduleOps struct {
	listSubmodulesFunc      func(ctx context.Context, repoPath string) ([]Submodule, error)
	setSubmoduleURLFunc     func(ctx context.Context, repoPath, name, newURL string) error
	initAndUpdateSubmodFunc func(ctx context.Context, repoPath string) error
	addSubmoduleFunc        func(ctx context.Context, repoPath, name, url string) error

	// Tracking fields for test assertions
	listSubmodulesCalled  bool
	setSubmoduleURLCalled bool
	setSubmoduleURLName   string
	setSubmoduleURLURL    string
	setSubmoduleURLCalls  []struct{ Name, URL string }
	initAndUpdateCalled   bool
	addSubmoduleCalls     []struct{ Name, URL string }
}

func (m *mockSubmoduleOps) ListSubmodules(ctx context.Context, repoPath string) ([]Submodule, error) {
	m.listSubmodulesCalled = true
	if m.listSubmodulesFunc != nil {
		return m.listSubmodulesFunc(ctx, repoPath)
	}
	return nil, nil
}

func (m *mockSubmoduleOps) SetSubmoduleURL(ctx context.Context, repoPath, name, newURL string) error {
	m.setSubmoduleURLCalled = true
	m.setSubmoduleURLName = name
	m.setSubmoduleURLURL = newURL
	m.setSubmoduleURLCalls = append(m.setSubmoduleURLCalls, struct{ Name, URL string }{name, newURL})
	if m.setSubmoduleURLFunc != nil {
		return m.setSubmoduleURLFunc(ctx, repoPath, name, newURL)
	}
	return nil
}

func (m *mockSubmoduleOps) InitAndUpdateSubmodules(ctx context.Context, repoPath string) error {
	m.initAndUpdateCalled = true
	if m.initAndUpdateSubmodFunc != nil {
		return m.initAndUpdateSubmodFunc(ctx, repoPath)
	}
	return nil
}

func (m *mockSubmoduleOps) AddSubmodule(ctx context.Context, repoPath, name, url string) error {
	m.addSubmoduleCalls = append(m.addSubmoduleCalls, struct{ Name, URL string }{name, url})
	if m.addSubmoduleFunc != nil {
		return m.addSubmoduleFunc(ctx, repoPath, name, url)
	}
	return nil
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
// Compile-time interface checks
// ──────────────────────────────────────────────

var (
	_ Authenticator = (*mockAuthenticator)(nil)
	_ GitHubClient  = (*mockGitHubClient)(nil)
	_ submoduleOps  = (*mockSubmoduleOps)(nil)
)
