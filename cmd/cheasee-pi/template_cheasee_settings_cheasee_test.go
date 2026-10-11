package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
