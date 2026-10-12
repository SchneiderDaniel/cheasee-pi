package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestConfigWrite_CreatesDir0700File0600NoTmp(t *testing.T) {
	// Pin the single dir mode after Save's 0700 died: writeRawMap's
	// MkdirAll(dir, 0700) is the only creator, files are 0600 secrets, and
	// no .tmp may remain after the atomic rename.
	dir := testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	if err := cfg.SetLegacyAuth(context.Background(), "opencode-go", FakeAPIKey, "/ws"); err != nil {
		t.Fatalf("SetLegacyAuth: %v", err)
	}

	configDir := filepath.Join(dir, "cheasee-pi")
	dirInfo, err := os.Stat(configDir)
	if err != nil {
		t.Fatalf("config directory not created: %v", err)
	}
	if !dirInfo.IsDir() {
		t.Error("config path is not a directory")
	}
	if dirInfo.Mode().Perm() != 0700 {
		t.Errorf("config dir mode = %v, want 0700", dirInfo.Mode().Perm())
	}

	path := filepath.Join(configDir, "auth.json")
	fileInfo, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat auth.json: %v", err)
	}
	if fileInfo.Mode().Perm() != 0600 {
		t.Errorf("auth.json mode = %v, want 0600", fileInfo.Mode().Perm())
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Error("no .tmp file may remain after the patch write")
	}
}

func TestConfigSpecialChars_RoundTrip(t *testing.T) {
	// Special-char keys survive the raw-map round-trip through both writers:
	// AddProvider → ListProviders and SetLegacyAuth → raw-map read (re-homes
	// the old Save/Load special-chars contract).
	specialKey := `key-"quoted"-with\backslash and ünicode`
	testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	ctx := context.Background()
	if err := cfg.AddProvider(ctx, "openai", specialKey); err != nil {
		t.Fatalf("AddProvider: %v", err)
	}
	providers, err := cfg.ListProviders(ctx)
	if err != nil {
		t.Fatalf("ListProviders: %v", err)
	}
	if providers["openai"] != specialKey {
		t.Errorf("AddProvider round-trip failed: expected %q, got %q", specialKey, providers["openai"])
	}

	if err := cfg.SetLegacyAuth(ctx, "opencode-go", specialKey, "/ws with space"); err != nil {
		t.Fatalf("SetLegacyAuth: %v", err)
	}
	raw := readAuthJSON(t)
	if got := providerKey(t, raw, "opencode-go"); got != specialKey {
		t.Errorf("SetLegacyAuth round-trip failed: expected %q, got %q", specialKey, got)
	}
	if got := authField(t, raw, "repo_path"); got != "/ws with space" {
		t.Errorf("repo_path round-trip failed: expected %q, got %q", "/ws with space", got)
	}
}

func TestDedupeKey(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"doubled half dedupes", "abcdabcd", "abcd"},
		{"repeated short half dedupes", "abab", "ab"},
		{"odd length no-op", "abcde", "abcde"},
		{"prefix-unequal halves no-op", "abxxcd", "abxxcd"},
		{"short key no-op", "abc", "abc"},
		{"single char no-op", "a", "a"},
	}
	for _, tc := range cases {
		if got := dedupeKey(tc.in); got != tc.want {
			t.Errorf("dedupeKey(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestDedupeKeyGuardOnWriters(t *testing.T) {
	// The dedupe guard survives on both writers that take a key: AddProvider
	// and SetLegacyAuth (the old Save guard died with the typed codec).
	testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	ctx := context.Background()
	if err := cfg.AddProvider(ctx, "openai", "abcdabcd"); err != nil {
		t.Fatal(err)
	}
	providers, err := cfg.ListProviders(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if providers["openai"] != "abcd" {
		t.Errorf("AddProvider must dedupe pasted keys, got %q", providers["openai"])
	}

	if err := cfg.SetLegacyAuth(ctx, "opencode-go", "xyzxyz", "/ws"); err != nil {
		t.Fatal(err)
	}
	raw := readAuthJSON(t)
	if got := providerKey(t, raw, "opencode-go"); got != "xyz" {
		t.Errorf("SetLegacyAuth provider entry must dedupe pasted keys, got %q", got)
	}
	if got := authField(t, raw, "api_key"); got != "xyz" {
		t.Errorf("SetLegacyAuth api_key must dedupe pasted keys, got %q", got)
	}
}
