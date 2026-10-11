package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

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

func TestOSGitIdentity_touchesSeamForBothConfigReads(t *testing.T) {
	// osGitIdentity is the first raw-exec.Command site routed through the
	// seam: Lookup must issue exactly two Output-only commands, one per
	// config key, with no writer configuration.
	var seenCmd []string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		seenCmd = append(seenCmd, strings.Join(append([]string{name}, arg...), " "))
		m := &mockCmd{}
		switch name + " " + strings.Join(arg, " ") {
		case "git config --global user.name":
			m.outputFn = func() ([]byte, error) { return []byte("Test User\n"), nil }
		case "git config --global user.email":
			m.outputFn = func() ([]byte, error) { return []byte("test@example.com\n"), nil }
		}
		return m
	})

	name, email, err := (&osGitIdentity{}).Lookup()
	if err != nil {
		t.Fatalf("Lookup failed: %v", err)
	}
	if name != "Test User" || email != "test@example.com" {
		t.Errorf("Lookup = %q/%q, want Test User/test@example.com", name, email)
	}
	want := []string{"git config --global user.name", "git config --global user.email"}
	if !slices.Equal(seenCmd, want) {
		t.Errorf("seam calls = %v, want %v (Output-only, no writers)", seenCmd, want)
	}
}

func TestOSGitIdentity_configFailureYieldsEmptyFields(t *testing.T) {
	// A failing git config read must not error Lookup — empty fields, nil
	// err (the scaffold then falls back to the prompt/defaults).
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("not a git repository") }}
	})

	name, email, err := (&osGitIdentity{}).Lookup()
	if err != nil {
		t.Fatalf("Lookup must not error on config failure, got %v", err)
	}
	if name != "" || email != "" {
		t.Errorf("expected empty name/email on config failure, got %q/%q", name, email)
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
	if err := (&templateSettingsRenderer{
		source:       embeddedFS,
		templatePath: "embedded/pi/settings.json",
		dest:         func(workdir string) string { return filepath.Join(workdir, ".pi", "settings.json") },
	}).Scaffold(context.Background(), workdir, TemplateSettingsValues{
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
	scaffold := &templateSettingsRenderer{
		source:       embeddedFS,
		templatePath: "embedded/pi/settings.json",
		dest:         func(workdir string) string { return filepath.Join(workdir, ".pi", "settings.json") },
	}

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
	scaffold := &templateSettingsRenderer{
		source:       embeddedFS,
		templatePath: "embedded/pi/settings.json",
		dest:         func(workdir string) string { return filepath.Join(workdir, ".pi", "settings.json") },
	}
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
