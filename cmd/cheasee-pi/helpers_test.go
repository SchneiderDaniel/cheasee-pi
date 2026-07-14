package main

import (
	"context"
)

// mockDockerChecker simulates Docker check results without real Docker.
type mockDockerChecker struct {
	result *CheckResult
	err    error
}

func (m *mockDockerChecker) Check(_ context.Context) (*CheckResult, error) {
	return m.result, m.err
}

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

// Compile-time interface checks.
var (
	_ Checker   = (*mockDockerChecker)(nil)
	_ Checker   = (*mockCheckerCtx)(nil)
	_ Repository = (*mockRepository)(nil)
)
