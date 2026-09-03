package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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

func TestUpdateGitHubAuth_MalformedExistingErrorsWithoutOverwrite(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)
	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{invalid json}"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	cfg := &fileRepository{}
	err = cfg.UpdateGitHubAuth(context.Background(), "new-token", "octocat", "/ws")
	if err == nil {
		t.Fatal("expected error for malformed existing auth.json")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Error("malformed auth.json must not be overwritten")
	}
}

func TestUpdateGitHubAuth_AtomicWritePermsAndRoundTrip(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	if err := cfg.UpdateGitHubAuth(context.Background(), "new-token", "octocat", "/ws"); err != nil {
		t.Fatalf("UpdateGitHubAuth: %v", err)
	}

	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat auth.json: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Errorf("expected 0600 perms, got %v", info.Mode().Perm())
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Error("no .tmp file may remain after UpdateGitHubAuth")
	}

	token, err := cfg.GitHubToken(context.Background())
	if err != nil {
		t.Fatalf("GitHubToken round-trip: %v", err)
	}
	if token != "new-token" {
		t.Errorf("GitHubToken round-trip shows the new token, got %q", token)
	}
	raw := readAuthJSON(t)
	if got := authField(t, raw, "github_user"); got != "octocat" {
		t.Errorf("github_user = %q, want octocat", got)
	}
	if got := authField(t, raw, "repo_path"); got != "/ws" {
		t.Errorf("repo_path = %q, want /ws", got)
	}
	if providers, err := cfg.ListProviders(context.Background()); err != nil || len(providers) != 0 {
		t.Errorf("no providers should be present, got %v (err %v)", providers, err)
	}
}

// TestAtomicWrite_preservesExistingMode: rename replaces the inode, so a
// pre-existing chmod'd target must keep its mode across a rewrite; an absent
// target gets the caller's perm.
func TestAtomicWrite_preservesExistingMode(t *testing.T) {
	dir := t.TempDir()
	for _, want := range []os.FileMode{0600, 0640} {
		path := filepath.Join(dir, fmt.Sprintf("target-%o", want))
		if err := os.WriteFile(path, []byte("old"), want); err != nil {
			t.Fatal(err)
		}
		if err := atomicWrite(path, []byte("new"), 0644); err != nil {
			t.Fatalf("atomicWrite over %o: %v", want, err)
		}
		fi, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != want {
			t.Errorf("existing %o target must keep its mode after rewrite, got %v", want, fi.Mode().Perm())
		}
	}

	// Absent target gets the caller perm.
	path := filepath.Join(dir, "new-file")
	if err := atomicWrite(path, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0644 {
		t.Errorf("absent target must get caller perm 0644, got %v", fi.Mode().Perm())
	}
}

// TestSettingsSave_preservesChmoddedMode: Settings.Save over a 0600
// .pi/settings.json preserves 0600 — no silent 0644 reset via the rename.
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

func TestIsReservedAuthKey(t *testing.T) {
	cases := []struct {
		key  string
		want bool
	}{
		{"github_token", true},
		{"github_user", true},
		{"repo_path", true},
		{"api_key", true},
		{"openai", false},
		{"opencode-go", false},
		{"GitHub_Token", false}, // reserved set is case-sensitive
		{"", false},
	}
	for _, tc := range cases {
		if got := isReservedAuthKey(tc.key); got != tc.want {
			t.Errorf("isReservedAuthKey(%q) = %v, want %v", tc.key, got, tc.want)
		}
	}
}
