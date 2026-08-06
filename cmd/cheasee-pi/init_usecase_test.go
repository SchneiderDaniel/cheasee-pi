package main

import (
	"context"
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
			name:      "repo only",
			setup:     func(dir string) { os.MkdirAll(filepath.Join(dir, ".git"), 0755) },
			wantTitle: "Git repository detected but no docker-compose.yml. Re-apply configuration?",
		},
		{
			name: "compose only",
			setup: func(dir string) {
				os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("version: '3'\n"), 0644)
			},
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
		{name: "compose only", setup: func(dir string) {
			os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("version: '3'\n"), 0644)
		}},
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
