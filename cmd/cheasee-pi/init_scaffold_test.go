package main

import (
	"context"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunInitScaffold_IdentityFromConfig(t *testing.T) {
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	if err := runInitScaffold(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Provider = "opencode-go"
	})); err != nil {
		t.Fatalf("scaffold failed: %v", err)
	}

	// The dedicated file lives at the folder root, not under .pi/.
	raw := testutil.ReadCheaseeSettingsRaw(t, workdir)
	if raw["defaultProvider"] != "opencode-go" {
		t.Errorf("expected defaultProvider 'opencode-go', got %v", raw["defaultProvider"])
	}
	if raw["defaultModel"] != "deepseek-v4-flash" {
		t.Errorf("expected defaultModel 'deepseek-v4-flash' (first known opencode-go model), got %v", raw["defaultModel"])
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
	docker, ok := raw["docker"].(map[string]any)
	if !ok {
		t.Fatal("expected docker object")
	}
	if docker["memory"] != "2G" {
		t.Errorf("expected docker.memory '2G', got %v", docker["memory"])
	}
	// pi's own settings file is NOT scaffolded (pi self-scaffolds on first run).
	if _, err := os.Stat(filepath.Join(workdir, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Error("init must not scaffold .pi/settings.json (pi owns it now)")
	}
}

func TestRunInitScaffold_DefaultsOnEmptyIdentity(t *testing.T) {
	testutil.SetGitConfig(t, "")

	workdir := t.TempDir()
	// Declined identity prompt → default name/email written.
	if err := runInitScaffold(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Provider = "opencode-go"
		d.ConfirmFn = mockConfirmFn(false, nil)
	})); err != nil {
		t.Fatalf("scaffold failed: %v", err)
	}

	raw := testutil.ReadCheaseeSettingsRaw(t, workdir)
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

func TestGitIgnoreCheaseeSettings_AppendsIdempotently(t *testing.T) {
	workdir := t.TempDir()
	if err := gitIgnoreCheaseeSettings(workdir); err != nil {
		t.Fatalf("first append: %v", err)
	}
	first, err := os.ReadFile(filepath.Join(workdir, ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(first), "cheasee-settings.json") {
		t.Errorf(".gitignore missing the settings entry: %q", first)
	}

	// Idempotent: a second append adds no duplicate line.
	if err := gitIgnoreCheaseeSettings(workdir); err != nil {
		t.Fatalf("second append: %v", err)
	}
	second, err := os.ReadFile(filepath.Join(workdir, ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Errorf("second append must be byte-identical:\nfirst:  %q\nsecond: %q", first, second)
	}
}

func TestGitIgnoreCheaseeSettings_appendsAfterExistingContent(t *testing.T) {
	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, ".gitignore"), []byte("node_modules/\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := gitIgnoreCheaseeSettings(workdir); err != nil {
		t.Fatalf("append: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(workdir, ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if got != "node_modules/\ncheasee-settings.json\n" {
		t.Errorf("settings entry must append on its own line, got: %q", got)
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
			name:    "missing auth on github path",
			ports:   func() InitPorts { p := all; p.Auth = nil; return p },
			deps:    InitDeps{NoGitHub: false},
			wantErr: []string{"Ports.Auth"},
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

	if !strings.Contains(output, "cheasee-pi start") {
		t.Error("success message must reference 'cheasee-pi start'")
	}
	if strings.Contains(output, "bash docker/run-pi.sh") {
		t.Error("success message must NOT reference the removed convenience script")
	}
	if !strings.Contains(output, "✅ Init complete") {
		t.Error("success message must contain the checkmark and 'Init complete'")
	}
}
