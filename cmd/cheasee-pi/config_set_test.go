package main

import (
	"bytes"
	"context"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestSetLegacyAuth_PreservesProviders(t *testing.T) {
	// SetLegacyAuth after AddProvider: merge-safe, existing provider entries
	// are preserved (the typed Save this replaces reset the whole file).
	testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	ctx := context.Background()
	if err := cfg.AddProvider(ctx, "openai", "key-openai"); err != nil {
		t.Fatal(err)
	}
	if err := cfg.SetLegacyAuth(ctx, "opencode-go", "legacy-key", "/ws"); err != nil {
		t.Fatalf("SetLegacyAuth: %v", err)
	}
	providers, err := cfg.ListProviders(ctx)
	if err != nil {
		t.Fatalf("ListProviders: %v", err)
	}
	if providers["openai"] != "key-openai" || providers["opencode-go"] != "legacy-key" {
		t.Errorf("existing provider must survive SetLegacyAuth, got %v", providers)
	}
	raw := readAuthJSON(t)
	if got := authField(t, raw, "api_key"); got != "legacy-key" {
		t.Errorf("flat api_key = %q, want %q", got, "legacy-key")
	}
}

func TestSetLegacyAuth_PreservesGitHubFields(t *testing.T) {
	// SetLegacyAuth after UpdateGitHubAuth: github_token/github_user survive
	// the legacy patch; repo_path is one of the three keys SetLegacyAuth
	// owns and is overwritten (pinned deliberately).
	testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	ctx := context.Background()
	if err := cfg.UpdateGitHubAuth(ctx, "tkn", "octocat", "/ws"); err != nil {
		t.Fatal(err)
	}
	if err := cfg.SetLegacyAuth(ctx, "opencode-go", "legacy-key", "/ws2"); err != nil {
		t.Fatalf("SetLegacyAuth: %v", err)
	}
	raw := readAuthJSON(t)
	if got := authField(t, raw, "github_token"); got != "tkn" {
		t.Errorf("github_token must survive SetLegacyAuth, got %q", got)
	}
	if got := authField(t, raw, "github_user"); got != "octocat" {
		t.Errorf("github_user must survive SetLegacyAuth, got %q", got)
	}
	if got := authField(t, raw, "repo_path"); got != "/ws2" {
		t.Errorf("repo_path = %q, want %q", got, "/ws2")
	}
}

func TestSetLegacyAuth_EmptyAPIKeyPinned(t *testing.T) {
	// Deliberate contract, pinned: SetLegacyAuth always writes all three
	// keys even for an empty key — the provider entry carries {"key": ""},
	// api_key is written empty, repo_path is written. ListProviders drops
	// empty-key entries (matching AddProvider), so nothing is listed.
	testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	if err := cfg.SetLegacyAuth(context.Background(), "opencode-go", "", "/ws"); err != nil {
		t.Fatalf("SetLegacyAuth with empty key must succeed: %v", err)
	}
	raw := readAuthJSON(t)
	if len(raw) != 3 {
		t.Fatalf("all three keys must be written for an empty key, got %v", raw)
	}
	if got := providerKey(t, raw, "opencode-go"); got != "" {
		t.Errorf("provider entry key = %q, want empty", got)
	}
	if got := authField(t, raw, "api_key"); got != "" {
		t.Errorf("flat api_key = %q, want empty", got)
	}
	if got := authField(t, raw, "repo_path"); got != "/ws" {
		t.Errorf("repo_path = %q, want %q", got, "/ws")
	}
	providers, err := cfg.ListProviders(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 0 {
		t.Errorf("empty-key provider entries must not be listed, got %v", providers)
	}
}

func TestReservedKeyRejected(t *testing.T) {
	// AddProvider/RemoveProvider with a reserved auth.json key fail closed —
	// killing the `pi auth add github_token` clobber foot-gun — and leave
	// the file untouched.
	for _, tc := range []struct {
		name string
		key  string
	}{
		{"github_token", "github_token"},
		{"github_user", "github_user"},
		{"repo_path", "repo_path"},
		{"api_key", "api_key"},
	} {
		t.Run("add "+tc.name, func(t *testing.T) {
			writeAuthFile(t, `{"openai":{"key":"k"}}`)
			before := authJSONBytes(t)

			cfg := &fileRepository{}
			err := cfg.AddProvider(context.Background(), tc.key, "sneaky")
			if err == nil {
				t.Fatal("expected error for reserved provider name")
			}
			if !bytes.Equal(before, authJSONBytes(t)) {
				t.Error("auth.json must be unchanged after a reserved-key AddProvider")
			}
		})
		t.Run("remove "+tc.name, func(t *testing.T) {
			writeAuthFile(t, `{"github_token":"t","openai":{"key":"k"}}`)
			before := authJSONBytes(t)

			cfg := &fileRepository{}
			err := cfg.RemoveProvider(context.Background(), tc.key)
			if err == nil {
				t.Fatal("expected error for reserved provider name")
			}
			if !bytes.Equal(before, authJSONBytes(t)) {
				t.Error("auth.json must be unchanged after a reserved-key RemoveProvider")
			}
		})
	}
}
