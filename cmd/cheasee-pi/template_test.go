package main

import (
	"context"
	"encoding/json"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// EnvRenderer adapter tests
// ──────────────────────────────────────────────

func TestEnvRenderer_WritesCorrectLines(t *testing.T) {
	content := RenderEnv(t, EnvValues{
		HostUID:  "1000",
		HostGID:  "1001",
		GitName:  "Test User",
		GitEmail: "test@example.com",
	})

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
	content := RenderEnv(t, EnvValues{
		HostUID:  "1000",
		HostGID:  "1001",
		GitName:  "User With Spaces",
		GitEmail: "test@example.com",
	})

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

func TestOSGitIdentity_Lookup(t *testing.T) {
	testutil.SetGitConfig(t, "[user]\n\tname = Test User\n\temail = test@example.com\n")

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
	testutil.SetGitConfig(t, "[user]\n\tname = Test User\n")

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
	testutil.SetGitConfig(t, "")

	id := &osGitIdentity{}
	name, email, err := id.Lookup()
	if err != nil {
		t.Fatalf("Lookup failed: %v", err)
	}
	if name != "" || email != "" {
		t.Errorf("expected empty name/email for empty config, got %q/%q", name, email)
	}
}

func TestSettingsScaffold_WritesCorrectContent(t *testing.T) {
	workdir := ScaffoldSettings(t, TemplateSettingsValues{
		Provider: "opencode-go",
		GitName:  "Test User",
		GitEmail: "test@example.com",
		Memory:   "4G",
		CPUs:     "4.0",
	})

	raw := testutil.ReadSettingsRaw(t, workdir)
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

	// Absolute /opt/cheasee-pi resource paths (never ../private-pi/...).
	skills, ok := raw["skills"].([]any)
	if !ok || len(skills) != 1 || skills[0] != "/opt/cheasee-pi/.pi/skills" {
		t.Errorf("expected skills ['/opt/cheasee-pi/.pi/skills'], got %v", raw["skills"])
	}
	prompts, ok := raw["prompts"].([]any)
	if !ok || len(prompts) != 1 || prompts[0] != "/opt/cheasee-pi/.pi/prompts" {
		t.Errorf("expected prompts ['/opt/cheasee-pi/.pi/prompts'], got %v", raw["prompts"])
	}
	exts, ok := raw["extensions"].([]any)
	if !ok || len(exts) != 0 {
		t.Errorf("expected empty extensions without private-pi, got %v", raw["extensions"])
	}
	if raw["theme"] != "cheasee-pi" {
		t.Errorf("expected theme 'cheasee-pi', got %v", raw["theme"])
	}
	if raw["sessionDir"] != ".pi/sessions" {
		t.Errorf("expected sessionDir '.pi/sessions', got %v", raw["sessionDir"])
	}
}

func TestSettingsScaffold_NoPrivatePiOmitsEntries(t *testing.T) {
	// The pi template has no private-pi branches anymore (the flag is gone —
	// the image always clones the public cheasee-pi repo); the scaffold stays
	// valid JSON with the /opt/cheasee-pi/.pi paths.
	workdir := ScaffoldSettings(t, TemplateSettingsValues{})

	data, err := os.ReadFile(filepath.Join(workdir, ".pi", "settings.json"))
	if err != nil {
		t.Fatalf("read scaffold: %v", err)
	}
	if strings.Contains(string(data), "private-pi") {
		t.Errorf("scaffold must not reference private-pi paths:\n%s", data)
	}
	// Valid JSON (the empty extensions array must parse).
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Errorf("scaffold output must be valid JSON: %v\n%s", err, data)
	}
}

func TestSettingsScaffold_Idempotent(t *testing.T) {
	workdir := ScaffoldSettings(t, TemplateSettingsValues{
		Provider: "opencode-go",
		GitName:  "Original",
		GitEmail: "orig@example.com",
		Memory:   "2G",
		CPUs:     "2.0",
	})

	// Second call: should no-op (file exists)
	if err := NewSettingsScaffold().Scaffold(context.Background(), workdir, TemplateSettingsValues{
		Provider: "overwrite",
		GitName:  "Overwrite",
		GitEmail: "overwrite@example.com",
		Memory:   "8G",
		CPUs:     "8.0",
	}); err != nil {
		t.Fatalf("second Scaffold failed: %v", err)
	}

	// Content must still be from first call (unchanged)
	raw := testutil.ReadSettingsRaw(t, workdir)
	if raw["defaultProvider"] != "opencode-go" {
		t.Errorf("expected defaultProvider 'opencode-go' (unchanged), got %v", raw["defaultProvider"])
	}
}

func TestSettingsScaffold_EmptyValues(t *testing.T) {
	workdir := ScaffoldSettings(t, TemplateSettingsValues{}) // all empty

	raw := testutil.ReadSettingsRaw(t, workdir)

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

// ──────────────────────────────────────────────
// CheaseeSettings scaffold (dedicated cheasee-settings.json)
// ──────────────────────────────────────────────

func TestCheaseeSettingsScaffold_rendersValidJSONAtRoot(t *testing.T) {
	workdir := t.TempDir()
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), workdir, TemplateSettingsValues{
		Provider:     "opencode-go",
		DefaultModel: "deepseek-v4-flash",
		GitName:      "Test User",
		GitEmail:     "test@example.com",
		Memory:       "4G",
		CPUs:         "4.0",
		ClientID:     "test-client",
	}); err != nil {
		t.Fatalf("Scaffold failed: %v", err)
	}

	// The dedicated file lives at the folder root (not a hidden dir).
	data, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatalf("cheasee-settings.json missing at root: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("scaffold output must be valid JSON: %v\n%s", err, data)
	}
	if raw["defaultProvider"] != "opencode-go" {
		t.Errorf("defaultProvider = %v, want opencode-go", raw["defaultProvider"])
	}
	if raw["defaultModel"] != "deepseek-v4-flash" {
		t.Errorf("defaultModel = %v, want deepseek-v4-flash", raw["defaultModel"])
	}
	docker := raw["docker"].(map[string]any)
	if docker["memory"] != "4G" || docker["cpus"] != "4.0" {
		t.Errorf("docker section mismatch: %v", docker)
	}
	gitID := raw["gitIdentity"].(map[string]any)
	if gitID["name"] != "Test User" || gitID["email"] != "test@example.com" {
		t.Errorf("gitIdentity mismatch: %v", gitID)
	}
	oauth := raw["oauth"].(map[string]any)
	if oauth["clientID"] != "test-client" {
		t.Errorf("oauth.clientID = %v, want test-client", oauth["clientID"])
	}
}

func TestCheaseeSettingsScaffold_outputLoadsAsTypedCheaseeSettings(t *testing.T) {
	workdir := t.TempDir()
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), workdir, TemplateSettingsValues{
		Provider:       "opencode-go",
		GitName:        "Test User",
		GitEmail:       "test@example.com",
		Memory:         "4G",
		CPUs:           "4.0",
		ClientID:       "test-client",
		RepositoryURL:  "https://github.com/owner/repo.git",
		GitHubUser:     "octocat",
	}); err != nil {
		t.Fatalf("Scaffold failed: %v", err)
	}

	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatalf("scaffold output must load via LoadCheaseeSettings: %v", err)
	}
	if s.DefaultProvider != "opencode-go" {
		t.Errorf("defaultProvider mismatch: %+v", s)
	}
	if s.Docker != (DockerSettings{Memory: "4G", CPUs: "4.0"}) {
		t.Errorf("docker mismatch: %+v", s.Docker)
	}
	if s.GitIdentity != (GitIdentitySettings{Name: "Test User", Email: "test@example.com"}) {
		t.Errorf("gitIdentity mismatch: %+v", s.GitIdentity)
	}
	if s.OAuth.ClientID != "test-client" {
		t.Errorf("oauth.clientID mismatch: %+v", s.OAuth)
	}
	if s.Repository == nil || s.Repository.URL != "https://github.com/owner/repo.git" || s.Repository.User != "octocat" {
		t.Errorf("repository mismatch: %+v", s.Repository)
	}
}

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

func TestCheaseeSettingsScaffold_idempotent(t *testing.T) {
	workdir := t.TempDir()
	vals := TemplateSettingsValues{
		Provider: "opencode-go",
		GitName:  "Original",
		GitEmail: "orig@example.com",
		Memory:   "2G",
		CPUs:     "2.0",
		ClientID: "client-a",
	}
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), workdir, vals); err != nil {
		t.Fatalf("first Scaffold failed: %v", err)
	}

	// Second call with different values must no-op (never overwrites).
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), workdir, TemplateSettingsValues{
		Provider: "overwrite",
		GitName:  "Overwrite",
		GitEmail: "overwrite@example.com",
		Memory:   "8G",
		CPUs:     "8.0",
		ClientID: "client-b",
	}); err != nil {
		t.Fatalf("second Scaffold failed: %v", err)
	}

	raw := testutil.ReadCheaseeSettingsRaw(t, workdir)
	if raw["defaultProvider"] != "opencode-go" {
		t.Errorf("existing cheasee-settings.json must never be overwritten, got %v", raw["defaultProvider"])
	}
}
