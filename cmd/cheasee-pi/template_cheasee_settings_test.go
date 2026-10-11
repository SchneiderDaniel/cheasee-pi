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

func TestCheaseeSettingsScaffold_rendersValidJSONAtRoot(t *testing.T) {
	workdir := t.TempDir()
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), workdir, TemplateSettingsValues{
		Provider:     "opencode-go",
		DefaultModel: "deepseek-v4-flash",
		GitName:      "Test User",
		GitEmail:     "test@example.com",
		Memory:       "4G",
		CPUs:         "4.0",
		ClientID:     "test-client",
	}); err != nil {
		t.Fatalf("Scaffold failed: %v", err)
	}

	// The dedicated file lives at the folder root (not a hidden dir).
	data, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatalf("cheasee-settings.json missing at root: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("scaffold output must be valid JSON: %v\n%s", err, data)
	}
	if raw["defaultProvider"] != "opencode-go" {
		t.Errorf("defaultProvider = %v, want opencode-go", raw["defaultProvider"])
	}
	if raw["defaultModel"] != "deepseek-v4-flash" {
		t.Errorf("defaultModel = %v, want deepseek-v4-flash", raw["defaultModel"])
	}
	docker := raw["docker"].(map[string]any)
	if docker["memory"] != "4G" || docker["cpus"] != "4.0" {
		t.Errorf("docker section mismatch: %v", docker)
	}
	gitID := raw["gitIdentity"].(map[string]any)
	if gitID["name"] != "Test User" || gitID["email"] != "test@example.com" {
		t.Errorf("gitIdentity mismatch: %v", gitID)
	}
	oauth := raw["oauth"].(map[string]any)
	if oauth["clientID"] != "test-client" {
		t.Errorf("oauth.clientID = %v, want test-client", oauth["clientID"])
	}
}

func TestCheaseeSettingsScaffold_outputLoadsAsTypedCheaseeSettings(t *testing.T) {
	workdir := t.TempDir()
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), workdir, TemplateSettingsValues{
		Provider:      "opencode-go",
		GitName:       "Test User",
		GitEmail:      "test@example.com",
		Memory:        "4G",
		CPUs:          "4.0",
		ClientID:      "test-client",
		RepositoryURL: "https://github.com/owner/repo.git",
		GitHubUser:    "octocat",
	}); err != nil {
		t.Fatalf("Scaffold failed: %v", err)
	}

	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatalf("scaffold output must load via LoadCheaseeSettings: %v", err)
	}
	if s.DefaultProvider != "opencode-go" {
		t.Errorf("defaultProvider mismatch: %+v", s)
	}
	if s.Docker != (DockerSettings{Memory: "4G", CPUs: "4.0"}) {
		t.Errorf("docker mismatch: %+v", s.Docker)
	}
	if s.GitIdentity != (GitIdentitySettings{Name: "Test User", Email: "test@example.com"}) {
		t.Errorf("gitIdentity mismatch: %+v", s.GitIdentity)
	}
	if s.OAuth.ClientID != "test-client" {
		t.Errorf("oauth.clientID mismatch: %+v", s.OAuth)
	}
	if s.Repository == nil || s.Repository.URL != "https://github.com/owner/repo.git" || s.Repository.User != "octocat" {
		t.Errorf("repository mismatch: %+v", s.Repository)
	}
}

func TestCheaseeSettingsScaffold_repositorySectionRendered(t *testing.T) {
	workdir := t.TempDir()
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), workdir, TemplateSettingsValues{
		RepositoryURL: "https://github.com/owner/repo.git?x=1&y=2",
		GitHubUser:    "octocat",
	}); err != nil {
		t.Fatalf("Scaffold failed: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	// text/template does not HTML-escape: a repo URL with query params (&)
	// must render literally and stay valid JSON.
	if !strings.Contains(string(data), "https://github.com/owner/repo.git?x=1&y=2") {
		t.Errorf("repo URL must render literally (no HTML escaping), got: %s", data)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("output must be valid JSON: %v\n%s", err, data)
	}
	repo, ok := raw["repository"].(map[string]any)
	if !ok {
		t.Fatal("expected repository section")
	}
	if repo["url"] != "https://github.com/owner/repo.git?x=1&y=2" {
		t.Errorf("repository.url = %v", repo["url"])
	}
	if repo["user"] != "octocat" {
		t.Errorf("repository.user = %v, want octocat", repo["user"])
	}
}

func TestCheaseeSettingsScaffold_repositoryEmptyUser(t *testing.T) {
	// URL present, user resolution failed/empty (fail-open): the section is
	// emitted with an explicit empty user, and the output stays valid JSON.
	workdir := t.TempDir()
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), workdir, TemplateSettingsValues{
		RepositoryURL: "https://github.com/owner/repo.git",
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
	repo, ok := raw["repository"].(map[string]any)
	if !ok {
		t.Fatal("expected repository section")
	}
	if repo["url"] != "https://github.com/owner/repo.git" {
		t.Errorf("repository.url = %v", repo["url"])
	}
	if repo["user"] != "" {
		t.Errorf("repository.user = %v, want empty string present", repo["user"])
	}
}

func TestCheaseeSettingsScaffold_emptyValuesNoRepositoryKey(t *testing.T) {
	// Empty values → no repository key at all; the comma inside the
	// {{if .RepositoryURL}} guard keeps both branches valid JSON.
	workdir := t.TempDir()
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), workdir, TemplateSettingsValues{}); err != nil {
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
	if _, ok := raw["repository"]; ok {
		t.Error("empty values must not emit a repository key")
	}
}

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
