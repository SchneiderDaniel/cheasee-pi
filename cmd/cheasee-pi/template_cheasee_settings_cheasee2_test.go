package main

import (
	"context"
	"encoding/json"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheaseeSettingsScaffold_skillReposRendered(t *testing.T) {
	// Populated SkillRepos render as a valid JSON array (the {{if .SkillRepos}}
	// guard emits the key only when present).
	workdir := t.TempDir()
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), workdir, TemplateSettingsValues{
		SkillRepos: []string{"https://github.com/a/b", "git:github.com/c/d@v1"},
	}); err != nil {
		t.Fatalf("Scaffold failed: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("output must be valid JSON: %v\n%s", err, data)
	}
	repos, ok := raw["skillRepos"].([]any)
	if !ok {
		t.Fatal("expected skillRepos array")
	}
	if len(repos) != 2 || repos[0] != "https://github.com/a/b" || repos[1] != "git:github.com/c/d@v1" {
		t.Errorf("skillRepos = %v", repos)
	}
}

func TestCheaseeSettingsScaffold_nilSkillReposByteCompatible(t *testing.T) {
	// Rendering without SkillRepos must stay byte-compatible with the
	// pre-feature template: no skillRepos key, valid JSON.
	workdir := t.TempDir()
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), workdir, TemplateSettingsValues{
		Provider:      "opencode-go",
		GitName:       "Test User",
		GitEmail:      "test@example.com",
		Memory:        "2G",
		CPUs:          "2.0",
		ClientID:      "test-client",
		RepositoryURL: "https://github.com/owner/repo.git",
		GitHubUser:    "octocat",
	}); err != nil {
		t.Fatalf("Scaffold failed: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "skillRepos") {
		t.Errorf("nil SkillRepos must not emit a skillRepos key, got: %s", data)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("output must stay valid JSON: %v\n%s", err, data)
	}
}

func TestCheaseeSettingsScaffold_idempotent(t *testing.T) {
	workdir := t.TempDir()
	vals := TemplateSettingsValues{
		Provider: "opencode-go",
		GitName:  "Original",
		GitEmail: "orig@example.com",
		Memory:   "2G",
		CPUs:     "2.0",
		ClientID: "client-a",
	}
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), workdir, vals); err != nil {
		t.Fatalf("first Scaffold failed: %v", err)
	}

	// Second call with different values must no-op (never overwrites).
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), workdir, TemplateSettingsValues{
		Provider: "overwrite",
		GitName:  "Overwrite",
		GitEmail: "overwrite@example.com",
		Memory:   "8G",
		CPUs:     "8.0",
		ClientID: "client-b",
	}); err != nil {
		t.Fatalf("second Scaffold failed: %v", err)
	}

	raw := testutil.ReadCheaseeSettingsRaw(t, workdir)
	if raw["defaultProvider"] != "opencode-go" {
		t.Errorf("existing cheasee-settings.json must never be overwritten, got %v", raw["defaultProvider"])
	}
}
