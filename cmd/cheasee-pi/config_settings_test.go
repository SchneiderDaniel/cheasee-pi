package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestSettingsSave_preservesChmoddedMode(t *testing.T) {
	workdir := t.TempDir()
	path := filepath.Join(workdir, ".pi", "settings.json")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := LoadSettings(workdir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Save(workdir); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0600 {
		t.Errorf("0600 .pi/settings.json must keep 0600 through Settings.Save, got %v", fi.Mode().Perm())
	}
}

// ──────────────────────────────────────────────
// GitHubToken / ListProviders error classes
// ──────────────────────────────────────────────

func TestGitHubToken_MissingFileAndAbsentKey(t *testing.T) {
	// Missing file, absent key, and empty {} config all yield ("", nil) — the
	// fail-to-fallback contract pi up's GH_TOKEN chain relies on.
	testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	tok, err := cfg.GitHubToken(context.Background())
	if err != nil || tok != "" {
		t.Fatalf("missing file: GitHubToken = (%q, %v), want (\"\", nil)", tok, err)
	}

	writeAuthFile(t, `{"openai":{"key":"k"}}`)
	tok, err = cfg.GitHubToken(context.Background())
	if err != nil || tok != "" {
		t.Fatalf("absent key: GitHubToken = (%q, %v), want (\"\", nil)", tok, err)
	}

	writeAuthFile(t, `{}`)
	tok, err = cfg.GitHubToken(context.Background())
	if err != nil || tok != "" {
		t.Fatalf("empty {}: GitHubToken = (%q, %v), want (\"\", nil)", tok, err)
	}
}

func TestGitHubToken_PresentAndOldFlatFormatReadable(t *testing.T) {
	writeAuthFile(t, `{"github_token":"tok-123","openai":{"key":"k"},"api_key":"legacy"}`)
	cfg := &fileRepository{}
	tok, err := cfg.GitHubToken(context.Background())
	if err != nil {
		t.Fatalf("GitHubToken: %v", err)
	}
	if tok != "tok-123" {
		t.Errorf("GitHubToken = %q, want tok-123", tok)
	}

	// Old flat format {"api_key":…} + {"github_token":…} stays readable:
	// ListProviders skips api_key (it is not a provider), GitHubToken
	// returns the token, no error.
	writeAuthFile(t, fmt.Sprintf(`{"api_key": %q, "github_token": "tok-456"}`, FakeAPIKey))
	tok, err = cfg.GitHubToken(context.Background())
	if err != nil || tok != "tok-456" {
		t.Fatalf("old flat format: GitHubToken = (%q, %v), want tok-456", tok, err)
	}
	providers, err := cfg.ListProviders(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 0 {
		t.Errorf("api_key must not be listed as a provider, got %v", providers)
	}
}

func TestGitHubToken_Malformed(t *testing.T) {
	writeAuthFile(t, `{"github_token": 42}`) // non-string token
	cfg := &fileRepository{}
	if _, err := cfg.GitHubToken(context.Background()); err == nil {
		t.Error("malformed github_token must error")
	}
}

func TestListProvidersErrorClasses(t *testing.T) {
	testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	providers, err := cfg.ListProviders(context.Background())
	if err != nil || len(providers) != 0 {
		t.Fatalf("missing file: ListProviders = (%v, %v), want (empty map, nil)", providers, err)
	}

	writeAuthFile(t, `{invalid json}`)
	if _, err := cfg.ListProviders(context.Background()); err == nil {
		t.Error("invalid JSON must error")
	}

	dir := testutil.RedirectConfigHome(t)
	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := cfg.ListProviders(context.Background()); err == nil {
		t.Error("auth.json as a directory must error")
	}
	if _, err := cfg.GitHubToken(context.Background()); err == nil {
		t.Error("auth.json as a directory must error for GitHubToken too")
	}
}

// ──────────────────────────────────────────────
// Malformed-no-overwrite across all four writers
// ──────────────────────────────────────────────

func TestWriters_MalformedExistingErrorsWithoutOverwrite(t *testing.T) {
	// The no-overwrite-on-malformed contract holds for every writer via the
	// updateAuth chokepoint (UpdateGitHubAuth has its own dedicated test).
	writers := []struct {
		name string
		run  func(*fileRepository, context.Context) error
	}{
		{"AddProvider", func(cfg *fileRepository, ctx context.Context) error {
			return cfg.AddProvider(ctx, "openai", "k")
		}},
		{"SetLegacyAuth", func(cfg *fileRepository, ctx context.Context) error {
			return cfg.SetLegacyAuth(ctx, "opencode-go", "k", "/ws")
		}},
		{"RemoveProvider", func(cfg *fileRepository, ctx context.Context) error {
			return cfg.RemoveProvider(ctx, "openai")
		}},
	}
	for _, w := range writers {
		t.Run(w.name, func(t *testing.T) {
			writeAuthFile(t, `{invalid json}`)
			before := authJSONBytes(t)
			err := w.run(&fileRepository{}, context.Background())
			if err == nil {
				t.Fatal("expected error for malformed existing auth.json")
			}
			if !bytes.Equal(before, authJSONBytes(t)) {
				t.Error("malformed auth.json must not be overwritten")
			}
		})
	}
}

// ──────────────────────────────────────────────
// Write shape: perms, dir mode, special chars, dedupe, reserved set
// ──────────────────────────────────────────────
