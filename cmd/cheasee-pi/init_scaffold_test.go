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
	}), "https://github.com/owner/repo.git", "octocat"); err != nil {
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
	// Canonical repo URL + GitHub user land in the repository section.
	repo, ok := raw["repository"].(map[string]any)
	if !ok {
		t.Fatal("expected repository section")
	}
	if repo["url"] != "https://github.com/owner/repo.git" {
		t.Errorf("repository.url = %v, want https://github.com/owner/repo.git", repo["url"])
	}
	if repo["user"] != "octocat" {
		t.Errorf("repository.user = %v, want octocat", repo["user"])
	}
	// pi's own settings file is NOT scaffolded (pi self-scaffolds on first run).
	if _, err := os.Stat(filepath.Join(workdir, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Error("init must not scaffold .pi/settings.json (pi owns it now)")
	}
	// .pi skeleton dirs pre-exist (gitignore append + skeleton both run).
	if _, err := os.Stat(filepath.Join(workdir, ".gitignore")); err != nil {
		t.Errorf(".gitignore append must still run: %v", err)
	}
	for _, dir := range piSkeletonDirs {
		if _, err := os.Stat(filepath.Join(workdir, ".pi", dir)); err != nil {
			t.Errorf(".pi/%s missing after scaffold: %v", dir, err)
		}
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
	}), "", ""); err != nil {
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
	// Direct-callers contract: empty repo URL → no repository section.
	if _, ok := raw["repository"]; ok {
		t.Error("empty repo URL must not emit a repository section")
	}
}

func TestRunInitScaffold_IdempotentWithRepoURL(t *testing.T) {
	// Never overwrite an existing settings file, even when a re-scaffold
	// carries a different URL/user.
	testutil.SetGitConfig(t, testGitIdentityConfig)
	workdir := t.TempDir()
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Provider = "opencode-go"
	})
	if err := runInitScaffold(context.Background(), deps, "https://github.com/owner/repo.git", "octocat"); err != nil {
		t.Fatalf("first scaffold: %v", err)
	}
	first, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := runInitScaffold(context.Background(), deps, "https://github.com/other/repo.git", "someone-else"); err != nil {
		t.Fatalf("second scaffold: %v", err)
	}
	second, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Errorf("second scaffold must leave the settings file byte-identical:\nfirst:  %s\nsecond: %s", first, second)
	}
}

func TestRunInitScaffold_piIsFileErrorsAfterSettingsWrite(t *testing.T) {
	// Documented ordering trade-off: settings-before-skeleton. A skeleton
	// failure after the settings write surfaces the error (blocks re-init via
	// the probe marker) without rolling back the settings file.
	testutil.SetGitConfig(t, testGitIdentityConfig)
	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, ".pi"), []byte(""), 0644); err != nil {
		t.Fatal(err)
	}

	err := runInitScaffold(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
	}), "https://github.com/owner/repo.git", "octocat")
	if err == nil || !strings.Contains(err.Error(), ".pi") {
		t.Fatalf("expected error referencing .pi, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(workdir, "cheasee-settings.json")); statErr != nil {
		t.Errorf("settings file must be written before the skeleton error surfaces: %v", statErr)
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

func TestInit_SuccessMessageInStartFlow(t *testing.T) {
	// Start-triggered init (InStartFlow) prints "✅ Init complete" WITHOUT the
	// standalone "Next step: cheasee-pi start" hint — start continues into
	// the launch automatically.
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.RedirectConfigHome(t)

	output := testutil.CaptureStderr(t, func() {
		err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
			d.NoGitHub = true
			d.APIKey = FakeAPIKey
			d.InStartFlow = true
		}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	if !strings.Contains(output, "✅ Init complete") {
		t.Error("success message must contain the checkmark and 'Init complete'")
	}
	if strings.Contains(output, "Next step:") || strings.Contains(output, "cheasee-pi start") {
		t.Errorf("start-triggered init must not print the second-invocation hint, got: %q", output)
	}
}
