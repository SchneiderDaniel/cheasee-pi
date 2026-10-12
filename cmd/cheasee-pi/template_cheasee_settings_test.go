package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
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
