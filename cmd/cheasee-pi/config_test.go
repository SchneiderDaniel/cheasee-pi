package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestConfigSave_Load(t *testing.T) {
	testutil.RedirectConfigHome(t)

	cfg := &fileRepository{}
	auth := &Auth{APIKey: FakeAPIKey}

	ctx := context.Background()
	if err := cfg.Save(ctx, auth); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := cfg.Load(ctx)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if loaded.APIKey != FakeAPIKey {
		t.Errorf("expected API key %q, got %q", FakeAPIKey, loaded.APIKey)
	}
}

func TestConfigSave_CreatesDirectory(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)

	cfg := &fileRepository{}
	auth := &Auth{APIKey: FakeAPIKey}

	if err := cfg.Save(context.Background(), auth); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Verify directory was created
	configDir := filepath.Join(dir, "cheasee-pi")
	info, err := os.Stat(configDir)
	if err != nil {
		t.Fatalf("config directory not created: %v", err)
	}
	if !info.IsDir() {
		t.Error("config path is not a directory")
	}
}

func TestConfigSave_ValidJSON(t *testing.T) {
	testutil.RedirectConfigHome(t)

	cfg := &fileRepository{}
	auth := &Auth{APIKey: FakeAPIKey}

	if err := cfg.Save(context.Background(), auth); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	path, err := cfg.Path()
	if err != nil {
		t.Fatalf("Path failed: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read auth.json: %v", err)
	}

	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if result["api_key"] != FakeAPIKey {
		t.Errorf("expected api_key %q, got %v", FakeAPIKey, result["api_key"])
	}
}

func TestConfigSave_AtomicWrite(t *testing.T) {
	testutil.RedirectConfigHome(t)

	cfg := &fileRepository{}
	auth := &Auth{APIKey: FakeAPIKey}

	if err := cfg.Save(context.Background(), auth); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	path, err := cfg.Path()
	if err != nil {
		t.Fatalf("Path failed: %v", err)
	}

	// Verify no .tmp file remains
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Error("temporary .tmp file should not exist after successful Save")
	}
}

func TestConfigLoad_FileNotExists(t *testing.T) {
	testutil.RedirectConfigHome(t)

	cfg := &fileRepository{}
	loaded, err := cfg.Load(context.Background())
	if err != nil {
		t.Fatalf("Load of non-existent file should return empty Auth, got error: %v", err)
	}
	if loaded == nil {
		t.Fatal("Load should return non-nil Auth")
	}
	if loaded.APIKey != "" {
		t.Errorf("expected empty API key, got %q", loaded.APIKey)
	}
}

func TestConfigLoad_InvalidJSON(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)

	// Create auth.json with invalid JSON
	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	os.MkdirAll(filepath.Dir(path), 0700)
	os.WriteFile(path, []byte("{invalid json}"), 0600)

	cfg := &fileRepository{}
	_, err := cfg.Load(context.Background())
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestConfigLoad_PathIsDirectory(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)

	// Create auth.json as a directory
	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	os.MkdirAll(path, 0700)

	cfg := &fileRepository{}
	_, err := cfg.Load(context.Background())
	if err == nil {
		t.Fatal("expected error when auth.json is a directory")
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

func TestConfigSave_EmptyAPIKey(t *testing.T) {
	testutil.RedirectConfigHome(t)

	cfg := &fileRepository{}
	auth := &Auth{APIKey: ""}

	if err := cfg.Save(context.Background(), auth); err != nil {
		t.Fatalf("Save of empty API key should succeed: %v", err)
	}

	// Verify stored as empty string in JSON
	path, _ := cfg.Path()
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), `"api_key": ""`) {
		t.Errorf("expected empty api_key in JSON, got: %s", string(data))
	}
}

func TestConfigSave_SpecialChars(t *testing.T) {
	testutil.RedirectConfigHome(t)

	specialKey := `key-"quoted"-with\backslash and ünicode`
	cfg := &fileRepository{}
	auth := &Auth{APIKey: specialKey}

	if err := cfg.Save(context.Background(), auth); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := cfg.Load(context.Background())
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if loaded.APIKey != specialKey {
		t.Errorf("round-trip failed: expected %q, got %q", specialKey, loaded.APIKey)
	}
}

func TestAuthPerProvider_MarshalHasProviderSlot(t *testing.T) {
	auth := &Auth{
		APIKey:   FakeAPIKey,
		Provider: "opencode-go",
	}

	data := marshalAuth(t, auth)

	// Must contain the provider-keyed object
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal of output failed: %v", err)
	}

	providerEntry, ok := raw["opencode-go"]
	if !ok {
		t.Fatal("expected 'opencode-go' key in marshaled JSON")
	}
	entry, ok := providerEntry.(map[string]any)
	if !ok {
		t.Fatal("expected provider entry to be an object")
	}
	if entry["key"] != FakeAPIKey {
		t.Errorf("expected key %q, got %v", FakeAPIKey, entry["key"])
	}

	// Must NOT have flat api_key field
	if _, ok := raw["api_key"]; ok {
		t.Error("expected no flat 'api_key' field when Provider is set")
	}
}

func TestAuthPerProvider_MarshalNoProviderWritesFlat(t *testing.T) {
	auth := &Auth{
		APIKey: FakeAPIKey,
		// Provider is empty — should write flat api_key
	}

	data := marshalAuth(t, auth)

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal of output failed: %v", err)
	}

	if _, ok := raw["api_key"]; !ok {
		t.Error("expected flat 'api_key' field when Provider is empty")
	}
	if raw["api_key"] != FakeAPIKey {
		t.Errorf("expected api_key %q, got %v", FakeAPIKey, raw["api_key"])
	}
}

func TestAuthPerProvider_MarshalEmptyProviderNoKey(t *testing.T) {
	// GitHub-only auth: no Provider, no APIKey
	// When Provider is empty, api_key is always written at top level for
	// backward compatibility (even if empty string), preserving the
	// pre-existing TestConfigSave_EmptyAPIKey contract.
	auth := &Auth{
		GitHubToken: FakeGitHubToken,
		GitHubUser:  "testuser",
		RepoPath:    "/workspace",
	}

	data := marshalAuth(t, auth)

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal of output failed: %v", err)
	}

	// api_key is written even when empty because Provider is empty —
	// this maintains backward compat with pre-existing TestConfigSave_EmptyAPIKey
	if v, ok := raw["api_key"]; ok {
		if v != "" {
			t.Errorf("expected empty api_key string, got %v", v)
		}
	} else {
		t.Error("expected 'api_key' field (empty) for backward compat when Provider is empty")
	}
	if raw["github_token"] != FakeGitHubToken {
		t.Errorf("expected github_token %q, got %v", FakeGitHubToken, raw["github_token"])
	}
}

func TestAuthPerProvider_UnmarshalProviderFormat(t *testing.T) {
	data := fmt.Appendf(nil, `{
		"opencode-go": {"key": "%s"},
		"github_token": "%s",
		"github_user": "testuser",
		"repo_path": "/workspace"
	}`, FakeAPIKey, FakeGitHubToken)

	var auth Auth
	if err := json.Unmarshal(data, &auth); err != nil {
		t.Fatalf("Unmarshal of provider format failed: %v", err)
	}

	if auth.APIKey != FakeAPIKey {
		t.Errorf("expected APIKey %q, got %q", FakeAPIKey, auth.APIKey)
	}
	if auth.Provider != "opencode-go" {
		t.Errorf("expected Provider 'opencode-go', got %q", auth.Provider)
	}
	if auth.GitHubToken != FakeGitHubToken {
		t.Errorf("expected GitHubToken %q, got %q", FakeGitHubToken, auth.GitHubToken)
	}
	if auth.GitHubUser != "testuser" {
		t.Errorf("expected GitHubUser 'testuser', got %q", auth.GitHubUser)
	}
	if auth.RepoPath != "/workspace" {
		t.Errorf("expected RepoPath '/workspace', got %q", auth.RepoPath)
	}
}

func TestAuthPerProvider_UnmarshalFlatFormat(t *testing.T) {
	data := fmt.Appendf(nil, `{"api_key": "%s", "github_token": "%s"}`, FakeAPIKey, FakeGitHubToken)

	var auth Auth
	if err := json.Unmarshal(data, &auth); err != nil {
		t.Fatalf("Unmarshal of flat format failed: %v", err)
	}

	if auth.APIKey != FakeAPIKey {
		t.Errorf("expected APIKey %q, got %q", FakeAPIKey, auth.APIKey)
	}
	if auth.Provider != "" {
		t.Errorf("expected empty Provider for flat format, got %q", auth.Provider)
	}
	if auth.GitHubToken != FakeGitHubToken {
		t.Errorf("expected GitHubToken %q, got %q", FakeGitHubToken, auth.GitHubToken)
	}
}

func TestAuthPerProvider_SaveWritesJqParseableOutput(t *testing.T) {
	testutil.RedirectConfigHome(t)

	cfg := &fileRepository{}
	auth := &Auth{
		APIKey:   FakeAPIKey,
		Provider: "opencode-go",
	}

	if err := cfg.Save(context.Background(), auth); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Read raw file and verify it's valid JSON with expected structure
	path, _ := cfg.Path()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Saved file is not valid JSON: %v", err)
	}

	entry, ok := raw["opencode-go"]
	if !ok {
		t.Fatal("saved file must contain provider key 'opencode-go'")
	}
	entryMap, ok := entry.(map[string]any)
	if !ok {
		t.Fatal("provider entry must be an object")
	}
	if entryMap["key"] != FakeAPIKey {
		t.Errorf("expected key %q, got %v", FakeAPIKey, entryMap["key"])
	}
}

func TestAuthPerProvider_UnmarshalEmptyObject(t *testing.T) {
	data := []byte(`{}`)

	var auth Auth
	if err := json.Unmarshal(data, &auth); err != nil {
		t.Fatalf("Unmarshal of empty object failed: %v", err)
	}

	if auth.APIKey != "" {
		t.Errorf("expected empty APIKey, got %q", auth.APIKey)
	}
	if auth.GitHubToken != "" {
		t.Errorf("expected empty GitHubToken, got %q", auth.GitHubToken)
	}
}

func TestAuthPerProvider_UnmarshalMalformedJSON(t *testing.T) {
	data := []byte(`{not json}`)

	var auth Auth
	err := json.Unmarshal(data, &auth)
	if err == nil {
		t.Fatal("expected error for malformed JSON")
	}
}

func TestAuthPerProvider_RoundTripWithProvider(t *testing.T) {
	testutil.RedirectConfigHome(t)

	cfg := &fileRepository{}
	auth := &Auth{
		APIKey:      FakeAPIKey,
		Provider:    "opencode-go",
		GitHubToken: FakeGitHubToken,
		GitHubUser:  "testuser",
		RepoPath:    "/some/path",
	}

	if err := cfg.Save(context.Background(), auth); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := cfg.Load(context.Background())
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if loaded.APIKey != FakeAPIKey {
		t.Errorf("expected api_key %q, got %q", FakeAPIKey, loaded.APIKey)
	}
	if loaded.Provider != "opencode-go" {
		t.Errorf("expected Provider 'opencode-go', got %q", loaded.Provider)
	}
	if loaded.GitHubToken != FakeGitHubToken {
		t.Errorf("expected GitHubToken %q, got %q", FakeGitHubToken, loaded.GitHubToken)
	}
	if loaded.GitHubUser != "testuser" {
		t.Errorf("expected GitHubUser 'testuser', got %q", loaded.GitHubUser)
	}
	if loaded.RepoPath != "/some/path" {
		t.Errorf("expected RepoPath '/some/path', got %q", loaded.RepoPath)
	}
}

func TestAuthPerProvider_MarshalOmitGitHubTokenWhenEmpty(t *testing.T) {
	auth := &Auth{
		APIKey:   FakeAPIKey,
		Provider: "openai",
	}

	data := marshalAuth(t, auth)

	if bytes.Contains(data, []byte("github_token")) {
		t.Error("expected no github_token in output when empty")
	}
	if !bytes.Contains(data, []byte("openai")) {
		t.Error("expected openai provider key in output")
	}
}

func TestConfigBackwardCompat_OldAuthLoads(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)

	// Write old-format auth.json
	oldDir := filepath.Join(dir, "cheasee-pi")
	os.MkdirAll(oldDir, 0700)
	oldPath := filepath.Join(oldDir, "auth.json")
	oldContent := fmt.Sprintf(`{"api_key": "%s"}`, FakeAPIKey)
	os.WriteFile(oldPath, []byte(oldContent), 0600)

	cfg := &fileRepository{}
	auth, err := cfg.Load(context.Background())
	if err != nil {
		t.Fatalf("Load of old format failed: %v", err)
	}
	if auth.APIKey != FakeAPIKey {
		t.Errorf("expected API key %q, got %q", FakeAPIKey, auth.APIKey)
	}
	if auth.GitHubToken != "" {
		t.Errorf("expected empty GitHubToken for old format, got %q", auth.GitHubToken)
	}
}

func TestConfigBackwardCompat_RoundTripPreservesNewFields(t *testing.T) {
	testutil.RedirectConfigHome(t)

	cfg := &fileRepository{}
	auth := &Auth{
		APIKey:      FakeAPIKey,
		GitHubToken: FakeGitHubToken,
		GitHubUser:  "testuser",
		RepoPath:    "/some/path",
	}

	if err := cfg.Save(context.Background(), auth); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := cfg.Load(context.Background())
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if loaded.APIKey != FakeAPIKey {
		t.Errorf("expected api_key %q, got %q", FakeAPIKey, loaded.APIKey)
	}
	if loaded.GitHubToken != FakeGitHubToken {
		t.Errorf("expected GitHubToken %q, got %q", FakeGitHubToken, loaded.GitHubToken)
	}
	if loaded.GitHubUser != "testuser" {
		t.Errorf("expected GitHubUser 'testuser', got %q", loaded.GitHubUser)
	}
	if loaded.RepoPath != "/some/path" {
		t.Errorf("expected RepoPath '/some/path', got %q", loaded.RepoPath)
	}
}
