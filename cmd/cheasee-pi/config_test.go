package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// writeAuthFile seeds auth.json with the given raw content under a fresh
// config home (t.Setenv XDG_CONFIG_HOME). Reads afterwards go through the
// config-home helpers (readAuthJSON/authJSONBytes).
func writeAuthFile(t *testing.T, content string) {
	t.Helper()
	dir := testutil.RedirectConfigHome(t)
	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestAddProvider_MultipleProvidersListed(t *testing.T) {
	// The regression the typed dialect failed: the old Save round-trip
	// clobbered all but one provider; the raw-map patch keeps both.
	testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	ctx := context.Background()
	if err := cfg.AddProvider(ctx, "openai", "key-openai"); err != nil {
		t.Fatalf("AddProvider openai: %v", err)
	}
	if err := cfg.AddProvider(ctx, "anthropic", "key-anthropic"); err != nil {
		t.Fatalf("AddProvider anthropic: %v", err)
	}
	providers, err := cfg.ListProviders(ctx)
	if err != nil {
		t.Fatalf("ListProviders: %v", err)
	}
	if len(providers) != 2 || providers["openai"] != "key-openai" || providers["anthropic"] != "key-anthropic" {
		t.Errorf("both providers must survive the second AddProvider, got %v", providers)
	}
}

func TestUpdateGitHubAuth_PreservesProvidersViaPublicMethods(t *testing.T) {
	// UpdateGitHubAuth after AddProvider × 2: both providers survive and the
	// github fields are patched — driven entirely through the public surface
	// (no hand-written auth.json).
	testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	ctx := context.Background()
	if err := cfg.AddProvider(ctx, "openai", "key-openai"); err != nil {
		t.Fatalf("AddProvider openai: %v", err)
	}
	if err := cfg.AddProvider(ctx, "anthropic", "key-anthropic"); err != nil {
		t.Fatalf("AddProvider anthropic: %v", err)
	}
	if err := cfg.UpdateGitHubAuth(ctx, "new-token", "octocat", "/ws"); err != nil {
		t.Fatalf("UpdateGitHubAuth: %v", err)
	}

	providers, err := cfg.ListProviders(ctx)
	if err != nil {
		t.Fatalf("ListProviders: %v", err)
	}
	if providers["openai"] != "key-openai" || providers["anthropic"] != "key-anthropic" {
		t.Errorf("both providers must survive the github patch, got %v", providers)
	}
	raw := readAuthJSON(t)
	if got := authField(t, raw, "github_token"); got != "new-token" {
		t.Errorf("github_token must be patched, got %q", got)
	}
	if got := authField(t, raw, "github_user"); got != "octocat" {
		t.Errorf("github_user must be patched, got %q", got)
	}
	if got := authField(t, raw, "repo_path"); got != "/ws" {
		t.Errorf("repo_path must be patched, got %q", got)
	}
}

func TestSetLegacyAuth_WritesAllThreeKeys(t *testing.T) {
	// Legacy init patch: provider entry {"<provider>":{"key":…}} + flat
	// api_key + repo_path (the legacy top-level api_key write is one more
	// raw-map key); the provider is listable and a raw-map read shows all
	// three keys.
	testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	if err := cfg.SetLegacyAuth(context.Background(), "opencode-go", FakeAPIKey, "/ws"); err != nil {
		t.Fatalf("SetLegacyAuth: %v", err)
	}
	providers, err := cfg.ListProviders(context.Background())
	if err != nil {
		t.Fatalf("ListProviders: %v", err)
	}
	if providers["opencode-go"] != FakeAPIKey {
		t.Errorf("expected provider entry for opencode-go, got %v", providers)
	}
	raw := readAuthJSON(t)
	if len(raw) != 3 {
		t.Fatalf("expected api_key + provider + repo_path (3 keys), got %v", raw)
	}
	if got := providerKey(t, raw, "opencode-go"); got != FakeAPIKey {
		t.Errorf("provider entry key = %q, want %q", got, FakeAPIKey)
	}
	if got := authField(t, raw, "api_key"); got != FakeAPIKey {
		t.Errorf("flat api_key = %q, want %q", got, FakeAPIKey)
	}
	if got := authField(t, raw, "repo_path"); got != "/ws" {
		t.Errorf("repo_path = %q, want %q", got, "/ws")
	}
}
