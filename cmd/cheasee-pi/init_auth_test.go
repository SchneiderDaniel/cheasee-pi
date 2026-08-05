package main

import (
	"context"
	"fmt"
	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
	redirectConfigDir(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	setGitIdentity(t)
	ports := defaultMocks()

	workdir := t.TempDir()
	err := runInit(context.Background(), InitDeps{
		Ports:         ports,
		SubmoduleOps:  &mockSubmoduleOps{},
		NoDockerCheck: false,
		NoGitHub:      false,
		NoInput:       true,
		SourceFork:    SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"},
		Workdir:       workdir,
		ConfirmFn:     mockConfirmFn(true, nil),
		InputFn:       mockInputFn("", nil),
	})
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
	redirectConfigDir(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	setGitIdentity(t)

	ports := defaultMocks()

	workdir := t.TempDir()
	err := runInit(context.Background(), InitDeps{
		Ports:         ports,
		APIKey:        "sk-abc123",
		NoDockerCheck: false,
		NoGitHub:      true,
		NoInput:       true,
		SourceFork:    SourceForkInput{Mode: ModePromptFork},
		Workdir:       workdir,
		ConfirmFn:     mockConfirmFn(true, nil),
		InputFn:       mockInputFn("", nil),
	})
	if err != nil {
		t.Fatalf("legacy path should work: %v", err)
	}
	// Real extractor ran: compose files present.
	if _, err := os.Stat(filepath.Join(workdir, "docker", "docker-compose.yml")); err != nil {
		t.Errorf("extract should have run (docker/docker-compose.yml missing): %v", err)
	}
	// Real env renderer ran: docker/.env present with host uid/gid and git identity.
	envVals := readEnvFile(t, workdir)
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
	if auth.APIKey != "sk-abc123" {
		t.Errorf("expected API key 'sk-abc123', got %q", auth.APIKey)
	}
	if auth.RepoPath != workdir {
		t.Errorf("expected RepoPath %q, got %q", workdir, auth.RepoPath)
	}
}

func TestRunInitLegacy_ReturnsAuth(t *testing.T) {
	// runInitLegacy is auth-only: returns *Auth, does NOT save/extract/render
	auth, err := runInitLegacy(context.Background(), &fileRepository{}, "sk-legacy-key", "opencode-go")
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

	stubDockerCheck(t, nil, "24.0.9", nil)
	redirectConfigDir(t)
	ports := defaultMocks()

	// Override auth with one that respects cancelled context
	ports.Auth = &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return nil, ctx.Err()
		},
	}

	// Cancel right after docker check
	cancel()

	err := runInit(ctx, InitDeps{
		Ports:         ports,
		NoDockerCheck: false,
		NoGitHub:      false,
		NoInput:       true,
		SourceFork:    SourceForkInput{Mode: ModePromptFork},
		Workdir:       t.TempDir(),
		ConfirmFn:     mockConfirmFn(true, nil),
		InputFn:       mockInputFn("", nil),
	})
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
}
