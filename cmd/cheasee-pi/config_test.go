package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigSave_Load(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

	cfg := &fileRepository{}
	auth := &Auth{APIKey: "sk-abc123"}

	ctx := context.Background()
	if err := cfg.Save(ctx, auth); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := cfg.Load(ctx)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if loaded.APIKey != "sk-abc123" {
		t.Errorf("expected API key 'sk-abc123', got %q", loaded.APIKey)
	}
}

func TestConfigSave_CreatesDirectory(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

	cfg := &fileRepository{}
	auth := &Auth{APIKey: "sk-abc123"}

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
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

	cfg := &fileRepository{}
	auth := &Auth{APIKey: "sk-abc123"}

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
	if result["api_key"] != "sk-abc123" {
		t.Errorf("expected api_key 'sk-abc123', got %v", result["api_key"])
	}
}

func TestConfigSave_AtomicWrite(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

	cfg := &fileRepository{}
	auth := &Auth{APIKey: "sk-abc123"}

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
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

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
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

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
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

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
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

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
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

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
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

	specialKey := `sk-"quoted"-with\backslash and ünicode`
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
