package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestRemoveProvider_RemovesOnlyNamedProvider(t *testing.T) {
	writeAuthFile(t, `{"openai":{"key":"k1"},"anthropic":{"key":"k2"},"github_token":"t","repo_path":"/ws"}`)
	cfg := &fileRepository{}
	if err := cfg.RemoveProvider(context.Background(), "openai"); err != nil {
		t.Fatalf("RemoveProvider: %v", err)
	}
	raw := readAuthJSON(t)
	if _, ok := raw["openai"]; ok {
		t.Error("named provider must be removed")
	}
	providers, err := cfg.ListProviders(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if providers["anthropic"] != "k2" {
		t.Errorf("other providers must survive RemoveProvider, got %v", providers)
	}
	if got := authField(t, raw, "github_token"); got != "t" {
		t.Errorf("github_token must survive RemoveProvider, got %q", got)
	}
	if got := authField(t, raw, "repo_path"); got != "/ws" {
		t.Errorf("repo_path must survive RemoveProvider, got %q", got)
	}
}

func TestConfigPath(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)

	cfg := &fileRepository{}
	path, err := cfg.Path()
	if err != nil {
		t.Fatalf("Path() failed: %v", err)
	}

	expected := filepath.Join(dir, "cheasee-pi", "auth.json")
	if path != expected {
		t.Errorf("expected path %q, got %q", expected, path)
	}
}

func TestUpdateGitHubAuth_PreservesProvidersAndLegacyKey(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)
	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	legacy := fmt.Sprintf(`{"api_key":"legacy","openai":{"key":"k1"},"anthropic":{"key":"k2"},"github_token":"old-token","github_user":"old-user","repo_path":"/old"}`)
	if err := os.WriteFile(path, []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}

	cfg := &fileRepository{}
	if err := cfg.UpdateGitHubAuth(context.Background(), "new-token", "octocat", "/ws"); err != nil {
		t.Fatalf("UpdateGitHubAuth: %v", err)
	}

	var raw map[string]json.RawMessage
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read auth.json: %v", err)
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("auth.json must stay valid JSON: %v", err)
	}
	if got := string(raw["api_key"]); got != `"legacy"` {
		t.Errorf("legacy flat api_key must survive, got %s", got)
	}
	for provider, want := range map[string]string{"openai": "k1", "anthropic": "k2"} {
		var entry struct {
			Key string `json:"key"`
		}
		if err := json.Unmarshal(raw[provider], &entry); err != nil || entry.Key != want {
			t.Errorf("provider %q must survive, got %s (err %v)", provider, raw[provider], err)
		}
	}
	if got := string(raw["github_token"]); got != `"new-token"` {
		t.Errorf("github_token must be patched, got %s", got)
	}
	if got := string(raw["github_user"]); got != `"octocat"` {
		t.Errorf("github_user must be patched, got %s", got)
	}
	if got := string(raw["repo_path"]); got != `"/ws"` {
		t.Errorf("repo_path must be patched, got %s", got)
	}
}

func TestUpdateGitHubAuth_MissingFileCreatesOnlyGitHubFields(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)

	cfg := &fileRepository{}
	if err := cfg.UpdateGitHubAuth(context.Background(), "new-token", "octocat", "/ws"); err != nil {
		t.Fatalf("UpdateGitHubAuth: %v", err)
	}

	var raw map[string]json.RawMessage
	data, err := os.ReadFile(filepath.Join(dir, "cheasee-pi", "auth.json"))
	if err != nil {
		t.Fatalf("read auth.json: %v", err)
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("created file must be valid JSON: %v", err)
	}
	if len(raw) != 3 {
		t.Errorf("missing auth.json must create a file with only the github fields, got %v", raw)
	}
	for _, key := range []string{"github_token", "github_user", "repo_path"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("created file must contain %q", key)
		}
	}
}
