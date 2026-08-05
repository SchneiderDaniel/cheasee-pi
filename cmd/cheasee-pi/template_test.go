package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// EnvRenderer adapter tests
// ──────────────────────────────────────────────

func TestEnvRenderer_WritesCorrectLines(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "docker", ".env")

	r := &flatEnvRenderer{}
	err := r.Render(context.Background(), dest, EnvValues{
		HostUID:  "1000",
		HostGID:  "1001",
		GitName:  "Test User",
		GitEmail: "test@example.com",
	})
	if err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "HOST_UID=1000") {
		t.Errorf("missing HOST_UID: %s", content)
	}
	if !strings.Contains(content, "HOST_GID=1001") {
		t.Errorf("missing HOST_GID: %s", content)
	}
	if !strings.Contains(content, "HOST_GIT_NAME=") {
		t.Errorf("missing HOST_GIT_NAME: %s", content)
	}
	if !strings.Contains(content, "HOST_GIT_EMAIL=test@example.com") {
		t.Errorf("missing HOST_GIT_EMAIL: %s", content)
	}
}

func TestEnvRenderer_ShellEscapesWhitespace(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "docker", ".env")

	r := &flatEnvRenderer{}
	err := r.Render(context.Background(), dest, EnvValues{
		HostUID:  "1000",
		HostGID:  "1001",
		GitName:  "User With Spaces",
		GitEmail: "test@example.com",
	})
	if err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	content := string(data)

	// Value with spaces should be quoted
	if !strings.Contains(content, `HOST_GIT_NAME="User With Spaces"`) {
		t.Errorf("expected quoted git name: %s", content)
	}
}

func TestEnvRenderer_CreatesDir(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "deep", "nested", "docker", ".env")

	r := &flatEnvRenderer{}
	err := r.Render(context.Background(), dest, EnvValues{
		HostUID:  "1000",
		HostGID:  "1001",
		GitName:  "Test",
		GitEmail: "test@test.com",
	})
	if err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	if _, err := os.Stat(dest); os.IsNotExist(err) {
		t.Error("expected .env file to exist")
	}
}

func TestEnvRenderer_RejectsEmptyUID(t *testing.T) {
	r := &flatEnvRenderer{}
	err := r.Render(context.Background(), "/tmp/.env", EnvValues{
		HostUID:  "",
		HostGID:  "1001",
		GitName:  "Test",
		GitEmail: "test@test.com",
	})
	if err == nil {
		t.Fatal("expected error for empty UID")
	}
	if !strings.Contains(err.Error(), "HOST_UID") {
		t.Errorf("error should mention HOST_UID: %v", err)
	}
}

func TestEnvRenderer_RejectsEmptyGID(t *testing.T) {
	r := &flatEnvRenderer{}
	err := r.Render(context.Background(), "/tmp/.env", EnvValues{
		HostUID:  "1000",
		HostGID:  "",
		GitName:  "Test",
		GitEmail: "test@test.com",
	})
	if err == nil {
		t.Fatal("expected error for empty GID")
	}
	if !strings.Contains(err.Error(), "HOST_GID") {
		t.Errorf("error should mention HOST_GID: %v", err)
	}
}

// ──────────────────────────────────────────────
// ShellEscape tests
// ──────────────────────────────────────────────

func TestShellEscape_NoEscape(t *testing.T) {
	result := shellEscape("simple")
	if result != "simple" {
		t.Errorf("expected 'simple', got %q", result)
	}
}

func TestShellEscape_WithSpaces(t *testing.T) {
	result := shellEscape("User Name")
	if result != `"User Name"` {
		t.Errorf("expected quoted, got %q", result)
	}
}

func TestShellEscape_WithSpecialChars(t *testing.T) {
	result := shellEscape("test$VAR")
	if result != `"test$VAR"` {
		t.Errorf("expected quoted with $, got %q", result)
	}
}

// ──────────────────────────────────────────────
// UIDResolver adapter tests
// ──────────────────────────────────────────────

func TestOSUIDResolver_ReturnsValidValues(t *testing.T) {
	// On a system with os/user.Current() working, returns real UID/GID.
	// On a system where it fails, falls back to env or id command.
	r := &osUIDResolver{}
	uid, gid, err := r.Current()
	if err != nil {
		t.Fatalf("Current() failed: %v", err)
	}
	if uid == "" || gid == "" {
		t.Errorf("expected non-empty uid/gid, got %q/%q", uid, gid)
	}
}

func TestOSUIDResolver_FallbackChain(t *testing.T) {
	// The fallback chain only runs when os/user.Current() fails, which is not
	// observable in-process on CI (cgo-backed user lookup succeeds, and
	// Current() caches its first result). Guard with a skip.
	if _, err := user.Current(); err == nil {
		t.Skip("os/user.Current succeeds — fallback path unreachable in-process")
	}

	t.Setenv("UID", "1234")
	t.Setenv("GID", "5678")
	uid, gid, err := (&osUIDResolver{}).Current()
	if err != nil {
		t.Fatalf("Current() failed: %v", err)
	}
	if uid != "1234" {
		t.Errorf("expected UID fallback '1234', got %q", uid)
	}
	if gid != "5678" {
		t.Errorf("expected GID fallback '5678', got %q", gid)
	}
}

// ──────────────────────────────────────────────
// WorkingDirProbe adapter tests
// ──────────────────────────────────────────────

func TestOSWorkingDirProbe_Empty(t *testing.T) {
	dir := t.TempDir()
	p := &osWorkingDirProbe{}
	state, err := p.Inspect(dir)
	if err != nil {
		t.Fatalf("Inspect failed: %v", err)
	}
	if state != WorkdirEmpty {
		t.Errorf("expected WorkdirEmpty, got %s", state)
	}
}

func TestOSWorkingDirProbe_HasRepo(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".git"), 0755)

	p := &osWorkingDirProbe{}
	state, err := p.Inspect(dir)
	if err != nil {
		t.Fatalf("Inspect failed: %v", err)
	}
	if state != WorkdirHasRepo {
		t.Errorf("expected WorkdirHasRepo (%d), got %s (%d)", WorkdirHasRepo, state, state)
	}
}

func TestOSWorkingDirProbe_HasCompose(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("version: '3'\n"), 0644)

	p := &osWorkingDirProbe{}
	state, err := p.Inspect(dir)
	if err != nil {
		t.Fatalf("Inspect failed: %v", err)
	}
	if state != WorkdirHasCompose {
		t.Errorf("expected WorkdirHasCompose (%d), got %s (%d)", WorkdirHasCompose, state, state)
	}
}

func TestOSWorkingDirProbe_Complete(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".git"), 0755)
	os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("version: '3'\n"), 0644)

	p := &osWorkingDirProbe{}
	state, err := p.Inspect(dir)
	if err != nil {
		t.Fatalf("Inspect failed: %v", err)
	}
	if state != WorkdirComplete {
		t.Errorf("expected WorkdirComplete (%d), got %s (%d)", WorkdirComplete, state, state)
	}
}

// ──────────────────────────────────────────────
// WorkdirState tests (entity)
// ──────────────────────────────────────────────

func TestWorkdirState_IsComplete(t *testing.T) {
	if WorkdirEmpty.IsComplete() {
		t.Error("WorkdirEmpty should not be complete")
	}
	if WorkdirHasRepo.IsComplete() {
		t.Error("WorkdirHasRepo should not be complete")
	}
	if WorkdirHasCompose.IsComplete() {
		t.Error("WorkdirHasCompose should not be complete")
	}
	if !WorkdirComplete.IsComplete() {
		t.Error("WorkdirComplete should be complete")
	}
}

func TestWorkdirState_String(t *testing.T) {
	if WorkdirEmpty.String() != "empty" {
		t.Errorf("expected 'empty', got %q", WorkdirEmpty.String())
	}
	if WorkdirComplete.String() != "complete" {
		t.Errorf("expected 'complete', got %q", WorkdirComplete.String())
	}
}

// ──────────────────────────────────────────────
// EnvValues validation tests
// ──────────────────────────────────────────────

func TestEnvValues_Validate(t *testing.T) {
	tests := []struct {
		name    string
		vals    EnvValues
		wantErr bool
	}{
		{"valid", EnvValues{HostUID: "1000", HostGID: "1000"}, false},
		{"empty uid", EnvValues{HostUID: "", HostGID: "1000"}, true},
		{"empty gid", EnvValues{HostUID: "1000", HostGID: ""}, true},
		{"both empty", EnvValues{HostUID: "", HostGID: ""}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.vals.Validate()
			if tt.wantErr && err == nil {
				t.Error("expected error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
}

// ──────────────────────────────────────────────
// GitIdentity adapter tests
// ──────────────────────────────────────────────

// writeGitConfig writes a global git config file and points git at it
// hermetically (GIT_CONFIG_GLOBAL, git >= 2.32; system config disabled).
func writeGitConfig(t *testing.T, content string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	cfg := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(cfg, []byte(content), 0644); err != nil {
		t.Fatalf("write gitconfig: %v", err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", cfg)
	t.Setenv("GIT_CONFIG_SYSTEM", "/dev/null")
}

func TestOSGitIdentity_Lookup(t *testing.T) {
	writeGitConfig(t, "[user]\n\tname = Test User\n\temail = test@example.com\n")

	id := &osGitIdentity{}
	name, email, err := id.Lookup()
	if err != nil {
		t.Fatalf("Lookup failed: %v", err)
	}
	if name != "Test User" {
		t.Errorf("expected name 'Test User', got %q", name)
	}
	if email != "test@example.com" {
		t.Errorf("expected email 'test@example.com', got %q", email)
	}
}

func TestOSGitIdentity_NameOnly(t *testing.T) {
	writeGitConfig(t, "[user]\n\tname = Test User\n")

	id := &osGitIdentity{}
	name, email, err := id.Lookup()
	if err != nil {
		t.Fatalf("Lookup failed: %v", err)
	}
	if name != "Test User" {
		t.Errorf("expected name 'Test User', got %q", name)
	}
	if email != "" {
		t.Errorf("expected empty email when unset, got %q", email)
	}
}

func TestOSGitIdentity_NoConfig(t *testing.T) {
	writeGitConfig(t, "")

	id := &osGitIdentity{}
	name, email, err := id.Lookup()
	if err != nil {
		t.Fatalf("Lookup failed: %v", err)
	}
	if name != "" || email != "" {
		t.Errorf("expected empty name/email for empty config, got %q/%q", name, email)
	}
}

// ──────────────────────────────────────────────
// Phase 1: Settings scaffold renderer (entity)
// ──────────────────────────────────────────────

func TestSettingsScaffold_WritesCorrectContent(t *testing.T) {
	scaffold := NewSettingsScaffold()
	workdir := t.TempDir()

	vals := TemplateSettingsValues{
		Provider: "opencode-go",
		GitName:  "Test User",
		GitEmail: "test@example.com",
		Memory:   "4G",
		CPUs:     "4.0",
	}

	if err := scaffold.Scaffold(context.Background(), workdir, vals); err != nil {
		t.Fatalf("Scaffold failed: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(workdir, ".pi", "settings.json"))
	if err != nil {
		t.Fatalf("Read settings.json failed: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("settings.json is not valid JSON: %v", err)
	}

	if raw["defaultProvider"] != "opencode-go" {
		t.Errorf("expected defaultProvider 'opencode-go', got %v", raw["defaultProvider"])
	}
	if raw["defaultModel"] != "gpt-4o" {
		t.Errorf("expected defaultModel 'gpt-4o', got %v", raw["defaultModel"])
	}

	docker, ok := raw["docker"].(map[string]any)
	if !ok {
		t.Fatal("expected docker object")
	}
	if docker["memory"] != "4G" {
		t.Errorf("expected memory '4G', got %v", docker["memory"])
	}
	if docker["cpus"] != "4.0" {
		t.Errorf("expected cpus '4.0', got %v", docker["cpus"])
	}

	gitID, ok := raw["gitIdentity"].(map[string]any)
	if !ok {
		t.Fatal("expected gitIdentity object")
	}
	if gitID["name"] != "Test User" {
		t.Errorf("expected gitIdentity.name 'Test User', got %v", gitID["name"])
	}
	if gitID["email"] != "test@example.com" {
		t.Errorf("expected gitIdentity.email 'test@example.com', got %v", gitID["email"])
	}
}

func TestSettingsScaffold_Idempotent(t *testing.T) {
	scaffold := NewSettingsScaffold()
	workdir := t.TempDir()

	vals := TemplateSettingsValues{
		Provider: "opencode-go",
		GitName:  "Original",
		GitEmail: "orig@example.com",
		Memory:   "2G",
		CPUs:     "2.0",
	}

	// First call: write file
	if err := scaffold.Scaffold(context.Background(), workdir, vals); err != nil {
		t.Fatalf("first Scaffold failed: %v", err)
	}

	// Second call: should no-op (file exists)
	vals2 := TemplateSettingsValues{
		Provider: "overwrite",
		GitName:  "Overwrite",
		GitEmail: "overwrite@example.com",
		Memory:   "8G",
		CPUs:     "8.0",
	}
	if err := scaffold.Scaffold(context.Background(), workdir, vals2); err != nil {
		t.Fatalf("second Scaffold failed: %v", err)
	}

	// Content must still be from first call (unchanged)
	data, err := os.ReadFile(filepath.Join(workdir, ".pi", "settings.json"))
	if err != nil {
		t.Fatalf("Read settings.json failed: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("settings.json is not valid JSON: %v", err)
	}

	if raw["defaultProvider"] != "opencode-go" {
		t.Errorf("expected defaultProvider 'opencode-go' (unchanged), got %v", raw["defaultProvider"])
	}
}

func TestSettingsScaffold_EmptyValues(t *testing.T) {
	scaffold := NewSettingsScaffold()
	workdir := t.TempDir()

	vals := TemplateSettingsValues{} // all empty

	if err := scaffold.Scaffold(context.Background(), workdir, vals); err != nil {
		t.Fatalf("Scaffold failed: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(workdir, ".pi", "settings.json"))
	if err != nil {
		t.Fatalf("Read settings.json failed: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("settings.json is not valid JSON: %v", err)
	}

	// Empty values should be empty strings in output
	if raw["defaultProvider"] != "" {
		t.Errorf("expected empty defaultProvider, got %v", raw["defaultProvider"])
	}

	gitID, ok := raw["gitIdentity"].(map[string]any)
	if !ok {
		t.Fatal("expected gitIdentity object")
	}
	if gitID["name"] != "" {
		t.Errorf("expected empty gitIdentity.name, got %v", gitID["name"])
	}
	if gitID["email"] != "" {
		t.Errorf("expected empty gitIdentity.email, got %v", gitID["email"])
	}

	docker, ok := raw["docker"].(map[string]any)
	if !ok {
		t.Fatal("expected docker object")
	}
	if docker["memory"] != "" {
		t.Errorf("expected empty docker.memory, got %v", docker["memory"])
	}
	if docker["cpus"] != "" {
		t.Errorf("expected empty docker.cpus, got %v", docker["cpus"])
	}
}

func TestSettingsScaffold_InvalidWorkdir(t *testing.T) {
	scaffold := NewSettingsScaffold()

	vals := TemplateSettingsValues{
		Provider: "opencode-go",
		GitName:  "Test",
		GitEmail: "test@test.com",
		Memory:   "2G",
		CPUs:     "2.0",
	}

	// Pre-create .pi as file so MkdirAll fails with ENOTDIR
	workdir := t.TempDir()
	os.WriteFile(filepath.Join(workdir, ".pi"), []byte(""), 0644)

	err := scaffold.Scaffold(context.Background(), workdir, vals)
	if err == nil {
		t.Fatal("expected error when .pi is a file")
	}
	if !strings.Contains(err.Error(), ".pi") && !strings.Contains(err.Error(), "mkdir") && !strings.Contains(err.Error(), "file") {
		t.Errorf("error should mention .pi, mkdir, or file: %v", err)
	}
}

func TestSettingsScaffold_ContextCancelled(t *testing.T) {
	scaffold := NewSettingsScaffold()
	workdir := t.TempDir()

	vals := TemplateSettingsValues{
		Provider: "opencode-go",
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled

	err := scaffold.Scaffold(ctx, workdir, vals)
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
	if !strings.Contains(err.Error(), "context") {
		t.Errorf("error should mention context: %v", err)
	}
}
