package main

import (
	"context"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
			name:    "missing auth/github on github path",
			ports:   func() InitPorts { p := all; p.Auth = nil; p.GitHub = nil; return p },
			deps:    InitDeps{NoGitHub: false},
			wantErr: []string{"Ports.Auth", "Ports.GitHub"},
		},
		{
			name:  "missing auth allowed on no-github path",
			ports: func() InitPorts { p := all; p.Auth = nil; return p },
			deps:  InitDeps{NoGitHub: true},
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
