package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
)

// defaultMocks returns a set of working mock implementations for the genuine
// seam ports (network/external-service boundaries). In-process adapters
// (probe, extract, env, scaffold, remover, uid, git identity) are real.
func defaultMocks() InitPorts {
	return InitPorts{
		Auth: &mockAuthenticator{},
		GitHub: &mockGitHubClient{
			getUserFunc: func(ctx context.Context, token string) (string, error) {
				return "testuser", nil
			},
			createForkFunc: func(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error) {
				return "testuser/cheasee-pi", nil
			},
			waitForkFunc: func(ctx context.Context, token, owner, repo string) error {
				return nil
			},
		},
		Cloner:   &mockCloner{},
		GitInit:  &mockGitInitializer{},
	}
}

// setGitIdentity points git config lookups at a hermetic temp config file
// containing user.name/user.email, so real osGitIdentity lookups are
// deterministic and never fall through to interactive prompts. Serialized
// (no t.Parallel) because t.Setenv is process-wide.
func setGitIdentity(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	cfg := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(cfg, []byte("[user]\n\tname = Test User\n\temail = test@example.com\n"), 0644); err != nil {
		t.Fatalf("write gitconfig: %v", err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", cfg)
	t.Setenv("GIT_CONFIG_SYSTEM", "/dev/null")
}

// unsetGitIdentity points git config lookups at an empty file (no identity),
// the deterministic no-identity state for fallback tests.
func unsetGitIdentity(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	cfg := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(cfg, nil, 0644); err != nil {
		t.Fatalf("write gitconfig: %v", err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", cfg)
	t.Setenv("GIT_CONFIG_SYSTEM", "/dev/null")
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
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       true,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork},
		Workdir:        t.TempDir(),
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       true,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork},
		Workdir:        t.TempDir(),
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       true,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork},
		Workdir:        t.TempDir(),
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       true,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork},
		Workdir:        t.TempDir(),
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
	if err == nil {
		t.Fatal("expected error when Docker CheckResult.Err is set")
	}
}

func TestInitUseCase_NoDockerCheckFlag(t *testing.T) {
	setGitIdentity(t)
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: false,
		},
	}
	mockCfg := &mockRepository{}
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		APIKey:         "sk-abc123",
		NoDockerCheck:  true,
		NoGitHub:       true,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork},
		Workdir:        t.TempDir(),
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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
	setGitIdentity(t)
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: true,
			Running:   true,
			Version:   "24.0.9",
		},
	}
	mockCfg := &mockRepository{}
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		APIKey:         "sk-abc123",
		NoDockerCheck:  false,
		NoGitHub:       true,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork},
		Workdir:        t.TempDir(),
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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
	setGitIdentity(t)
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: true,
			Running:   true,
			Version:   "24.0.9",
		},
	}
	mockCfg := &mockRepository{saveErr: fmt.Errorf("disk full")}
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		APIKey:         "sk-abc123",
		NoDockerCheck:  false,
		NoGitHub:       true,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork},
		Workdir:        t.TempDir(),
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	err := runInit(ctx, InitDeps{
		Ports:          ports,
		APIKey:         "sk-abc123",
		NoDockerCheck:  false,
		NoGitHub:       true,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork},
		Workdir:        t.TempDir(),
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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
	setGitIdentity(t)
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	workdir := t.TempDir()
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
	if err != nil {
		t.Fatalf("full flow failed: %v", err)
	}
	if !mockCfg.saved {
		t.Error("Save should be called after full flow")
	}
}

func TestRunInit_NoGitHubFlag(t *testing.T) {
	// --no-github flag: extract + env + save all run after auth, with the
	// real in-process adapters (probe, extract, env render, scaffold).
	setGitIdentity(t)
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}

	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	workdir := t.TempDir()
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		APIKey:         "sk-abc123",
		NoDockerCheck:  false,
		NoGitHub:       true,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
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
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	// Override auth with one that respects cancelled context
	ports.Auth = &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return nil, ctx.Err()
		},
	}

	// Cancel right after docker check
	cancel()

	err := runInit(ctx, InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork},
		Workdir:        t.TempDir(),
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
}

// ──────────────────────────────────────────────
// Fork already exists test
// ──────────────────────────────────────────────

func TestRunInit_ForkAlreadyExists(t *testing.T) {
	setGitIdentity(t)
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

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
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	ports.GitHub = &mockGitHubClient{
		getUserFunc: func(ctx context.Context, token string) (string, error) {
			return "testuser", nil
		},
		createForkFunc: func(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error) {
			return "", fmt.Errorf("forbidden")
		},
	}

	workdir := t.TempDir()
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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
	stderr := captureStderr(t, func() {
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

// readEnvFile reads docker/.env and returns its KEY=VALUE lines as a map.
func readEnvFile(t *testing.T, workdir string) map[string]string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(workdir, "docker", ".env"))
	if err != nil {
		t.Fatalf("read docker/.env: %v", err)
	}
	vals := make(map[string]string)
	for _, line := range strings.Split(string(data), "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			vals[k] = strings.Trim(v, "\"")
		}
	}
	return vals
}

func TestRunInitEnv_Success(t *testing.T) {
	setGitIdentity(t)

	workdir := t.TempDir()
	if err := runInitEnv(context.Background(), workdir, mockConfirmFn(true, nil)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	vals := readEnvFile(t, workdir)
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
	unsetGitIdentity(t)

	workdir := t.TempDir()
	if err := runInitEnv(context.Background(), workdir, mockConfirmFn(false, nil)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	vals := readEnvFile(t, workdir)
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

// readSettingsFile reads .pi/settings.json and returns it as a map.
func readSettingsFile(t *testing.T, workdir string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(workdir, ".pi", "settings.json"))
	if err != nil {
		t.Fatalf("read .pi/settings.json: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("settings.json is not valid JSON: %v", err)
	}
	return raw
}

func TestRunInitScaffold_IdentityFromConfig(t *testing.T) {
	setGitIdentity(t)
	oldProvider := initProvider
	initProvider = "opencode-go"
	defer func() { initProvider = oldProvider }()

	workdir := t.TempDir()
	if err := runInitScaffold(context.Background(), workdir, mockConfirmFn(true, nil)); err != nil {
		t.Fatalf("scaffold failed: %v", err)
	}

	raw := readSettingsFile(t, workdir)
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
	unsetGitIdentity(t)
	oldProvider := initProvider
	initProvider = "opencode-go"
	defer func() { initProvider = oldProvider }()

	workdir := t.TempDir()
	// Declined identity prompt → default name/email written.
	if err := runInitScaffold(context.Background(), workdir, mockConfirmFn(false, nil)); err != nil {
		t.Fatalf("scaffold failed: %v", err)
	}

	raw := readSettingsFile(t, workdir)
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
	all.Cfg = &mockRepository{}
	all.Docker = &mockDockerChecker{}
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
			name:  "missing cfg",
			ports: func() InitPorts { p := all; p.Cfg = nil; return p },
			wantErr: []string{"Ports.Cfg"},
		},
		{
			name:  "missing docker when check enabled",
			ports: func() InitPorts { p := all; p.Docker = nil; return p },
			deps:    InitDeps{NoDockerCheck: false},
			wantErr: []string{"Ports.Docker"},
		},
		{
			name:  "missing docker allowed with no-docker-check",
			ports: func() InitPorts { p := all; p.Docker = nil; return p },
			deps:    InitDeps{NoDockerCheck: true},
		},
		{
			name:  "missing auth/github/cloner on github path",
			ports: func() InitPorts { p := all; p.Auth = nil; p.GitHub = nil; p.Cloner = nil; return p },
			deps:    InitDeps{NoGitHub: false},
			wantErr: []string{"Ports.Auth", "Ports.GitHub", "Ports.Cloner"},
		},
		{
			name:  "missing gitinit on no-github path",
			ports: func() InitPorts { p := all; p.GitInit = nil; return p },
			deps:    InitDeps{NoGitHub: true},
			wantErr: []string{"Ports.GitInit"},
		},
		{
			name:  "missing gitinit allowed on github path",
			ports: func() InitPorts { p := all; p.GitInit = nil; return p },
			deps:    InitDeps{NoGitHub: false},
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
	setGitIdentity(t)
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
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	err = runInit(context.Background(), InitDeps{
		Ports:          ports,
		APIKey:         "sk-abc123",
		NoDockerCheck:  false,
		NoGitHub:       true,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork},
		Workdir:        t.TempDir(),
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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
	setGitIdentity(t)
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	workdir := t.TempDir()
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModeSkipFork},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
	if err != nil {
		t.Fatalf("skip-fork flow failed: %v", err)
	}
	if !mockCfg.saved {
		t.Error("Save should be called after skip-fork flow")
	}
}

func TestRunInit_ForkURL(t *testing.T) {
	setGitIdentity(t)
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

	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg
	ports.Cloner = clone

	workdir := t.TempDir()
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModeUseForkURL, ForkURL: "https://github.com/user/existing-fork.git"},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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
	setGitIdentity(t)
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
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg
	ports.Auth = mockAuth
	ports.GitHub = mockGH
	ports.Cloner = clone

	workdir := t.TempDir()
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModeUseForkURL, ForkURL: "https://github.com/user/existing-fork.git"},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	workdir := t.TempDir()
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModeUseForkURL, ForkURL: ""},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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
	setGitIdentity(t)
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	workdir := t.TempDir()
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        false,
		SourceFork:     SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil, "Configure API keys"),
		InputFn:        mockInputFn("", nil),
	})
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
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	workdir := t.TempDir()
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        false,
		SourceFork:     SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(false, nil),
		InputFn:        mockInputFn("", nil),
	})
	if err != nil {
		t.Fatalf("expected nil error (clean exit) when confirm is declined: %v", err)
	}
	if mockCfg.saved {
		t.Error("Save should NOT be called when confirm is declined")
	}
}

func TestRunInit_PostCloneConfirm_NoInputSkipsPrompt(t *testing.T) {
	// With noInput=true, the post-clone confirm should be skipped
	setGitIdentity(t)
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}
	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	// If confirm were called with false, we'd error (but it won't be called)
	workdir := t.TempDir()
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"},
		Workdir:        workdir,
		InputFn:        mockInputFn("", nil),
	})
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

	// Use null byte in path — forces EINVAL from git init
	err := gitInit.Init(context.Background(), "/nonexistent\x00path")
	if err == nil {
		t.Fatal("expected error for invalid path with null byte")
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
	stderr := captureStderr(t, func() {
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

	stderr := captureStderr(t, func() {
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

	stderr := captureStderr(t, func() {
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

	stderr := captureStderr(t, func() {
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
	setGitIdentity(t)
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}

	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	workdir := t.TempDir()
	seedCloneFixture(t, workdir)
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}

	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	workdir := t.TempDir()
	os.MkdirAll(filepath.Join(workdir, ".git"), 0755)
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), []byte("unmatched[brackets\n"), 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
	if err == nil {
		t.Fatal("expected error when remover fails")
	}
	if !strings.Contains(err.Error(), "post-clone cleanup") {
		t.Errorf("error should wrap with phase prefix: %v", err)
	}
}

func TestRunInit_RemoverSkipFork(t *testing.T) {
	setGitIdentity(t)
	mockDocker := &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}
	mockCfg := &mockRepository{}

	ports := defaultMocks()
	ports.Docker = mockDocker
	ports.Cfg = mockCfg

	workdir := t.TempDir()
	seedCloneFixture(t, workdir)
	err := runInit(context.Background(), InitDeps{
		Ports:          ports,
		NoDockerCheck:  false,
		NoGitHub:       false,
		NoInput:        true,
		SourceFork:     SourceForkInput{Mode: ModeSkipFork},
		Workdir:        workdir,
		ConfirmFn:      mockConfirmFn(true, nil),
		InputFn:        mockInputFn("", nil),
	})
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

// captureStderr runs fn and returns any output written to stderr.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	orig := os.Stderr
	os.Stderr = w

	out := make(chan string, 1)
	go func() {
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(r)
		out <- buf.String()
	}()

	fn()

	os.Stderr = orig
	w.Close()
	return <-out
}