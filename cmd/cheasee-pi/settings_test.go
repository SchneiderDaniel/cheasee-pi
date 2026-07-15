package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sampleSettingsJSON is a realistic .pi/settings.json fixture.
const sampleSettingsJSON = `{
	"packages": [
		{
			"source": "https://github.com/DietrichGebert/ponytail",
			"extensions": [],
			"skills": []
		}
	],
	"defaultProvider": "opencode-go",
	"defaultModel": "deepseek-v4-flash",
	"quietStartup": true,
	"theme": "cheasee-pi",
	"sessionDir": ".pi/sessions",
	"contextStatusBar": {
		"showTps": true
	},
	"docker": {
		"memory": "5G",
		"cpus": "4.0"
	},
	"skills": [".pi/skills", "private-pi/skills"],
	"prompts": [
		"prompts",
		"prompts/operations",
		"prompts/development",
		"prompts/requirement",
		"prompts/misc",
		"private-pi/prompts"
	],
	"supervisor": {
		"repo": "SchneiderDaniel/cheasee-pi",
		"projectNumber": 3,
		"statusField": "Status",
		"statusMapping": {
			"Research": "researcher",
			"Architecture": "architect",
			"TestDesign": "test-designer",
			"Implementation": "developer",
			"Audit": "auditor"
		},
		"maxRejections": 3,
		"codeowners": ["SchneiderDaniel"],
		"agentTimeoutsMin": {},
		"agentTokenBudget": 300000,
		"bellOnComplete": false,
		"enableExperimentalFeatures": false
	}
}`

// ──────────────────────────────────────────────
// Phase 1: SettingsGenerator adapter tests
// ──────────────────────────────────────────────

func TestSettingsAdapter_HappyPath(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	// Create source settings.json
	os.MkdirAll(filepath.Dir(dest), 0755)
	if err := os.WriteFile(dest, []byte(sampleSettingsJSON), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	gen := NewSettingsGenerator()
	vals := SettingsValues{
		GitHubUser: "testuser",
		RepoName:   "cheasee-pi",
		SourceRepo: "SchneiderDaniel/cheasee-pi",
	}

	if err := gen.Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	// Read output and verify
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}

	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}

	// 1. supervisor.repo should be updated
	supervisor, ok := result["supervisor"].(map[string]any)
	if !ok {
		t.Fatal("supervisor key missing or not an object")
	}
	if repo := supervisor["repo"].(string); repo != "testuser/cheasee-pi" {
		t.Errorf("expected supervisor.repo 'testuser/cheasee-pi', got %q", repo)
	}

	// 2. skills should not contain private-pi/skills
	skills, ok := result["skills"].([]any)
	if !ok {
		t.Fatal("skills key missing or not an array")
	}
	for _, s := range skills {
		if s == "private-pi/skills" {
			t.Error("skills should not contain private-pi/skills")
		}
	}

	// 3. prompts should not contain private-pi/prompts
	prompts, ok := result["prompts"].([]any)
	if !ok {
		t.Fatal("prompts key missing or not an array")
	}
	for _, p := range prompts {
		if p == "private-pi/prompts" {
			t.Error("prompts should not contain private-pi/prompts")
		}
	}

	// 4. Other fields should be preserved
	if _, ok := result["packages"]; !ok {
		t.Error("packages should be preserved")
	}
	if _, ok := result["contextStatusBar"]; !ok {
		t.Error("contextStatusBar should be preserved")
	}

	// 5. Output is human-readable (uses tabs like original)
	if !strings.Contains(string(data), "\t\t") {
		t.Error("expected tab-indented JSON output")
	}
}

func TestSettingsAdapter_AtomicWrite(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	os.MkdirAll(filepath.Dir(dest), 0755)
	if err := os.WriteFile(dest, []byte(sampleSettingsJSON), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	gen := NewSettingsGenerator()
	vals := SettingsValues{GitHubUser: "testuser", RepoName: "cheasee-pi"}

	if err := gen.Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	// No .tmp file should remain
	tmpPath := dest + ".tmp"
	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Error("tmp file should be removed after successful Render")
	}

	// Output file should exist and be non-empty
	info, err := os.Stat(dest)
	if err != nil {
		t.Fatalf("output file stat: %v", err)
	}
	if info.Size() == 0 {
		t.Error("output file should not be empty")
	}
}

func TestSettingsAdapter_MissingSourceFile(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	gen := NewSettingsGenerator()
	vals := SettingsValues{GitHubUser: "testuser", RepoName: "cheasee-pi"}

	err := gen.Render(context.Background(), dest, vals)
	if err == nil {
		t.Fatal("expected error for missing source file")
	}
	if !strings.Contains(err.Error(), "settings.json") {
		t.Errorf("error should mention settings.json: %v", err)
	}
}

func TestSettingsAdapter_MalformedJSON(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	os.MkdirAll(filepath.Dir(dest), 0755)
	if err := os.WriteFile(dest, []byte(`{invalid`), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	gen := NewSettingsGenerator()
	vals := SettingsValues{GitHubUser: "testuser", RepoName: "cheasee-pi"}

	err := gen.Render(context.Background(), dest, vals)
	if err == nil {
		t.Fatal("expected error for malformed JSON")
	}
	if !strings.Contains(err.Error(), "invalid") {
		t.Errorf("error should propagate JSON syntax error: %v", err)
	}
}

func TestSettingsAdapter_NoPrivatePiEntries(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	input := `{
		"skills": [".pi/skills"],
		"prompts": ["prompts"],
		"supervisor": {"repo": "SchneiderDaniel/cheasee-pi"}
	}`
	os.MkdirAll(filepath.Dir(dest), 0755)
	if err := os.WriteFile(dest, []byte(input), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	gen := NewSettingsGenerator()
	vals := SettingsValues{GitHubUser: "testuser", RepoName: "cheasee-pi"}

	if err := gen.Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}

	var result map[string]any
	json.Unmarshal(data, &result)

	// Arrays should be unchanged
	skills := result["skills"].([]any)
	if len(skills) != 1 || skills[0] != ".pi/skills" {
		t.Errorf("skills should be unchanged: %v", skills)
	}
	prompts := result["prompts"].([]any)
	if len(prompts) != 1 || prompts[0] != "prompts" {
		t.Errorf("prompts should be unchanged: %v", prompts)
	}
}

func TestSettingsAdapter_EmptyArrays(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	input := `{
		"skills": [],
		"prompts": [],
		"supervisor": {"repo": "SchneiderDaniel/cheasee-pi"}
	}`
	os.MkdirAll(filepath.Dir(dest), 0755)
	if err := os.WriteFile(dest, []byte(input), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	gen := NewSettingsGenerator()
	vals := SettingsValues{GitHubUser: "testuser", RepoName: "cheasee-pi"}

	if err := gen.Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}

	var result map[string]any
	json.Unmarshal(data, &result)

	skills := result["skills"].([]any)
	if len(skills) != 0 {
		t.Errorf("expected empty skills, got %v", skills)
	}
	prompts := result["prompts"].([]any)
	if len(prompts) != 0 {
		t.Errorf("expected empty prompts, got %v", prompts)
	}
}

func TestSettingsAdapter_PrivatePiOnlyInOneArray(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	input := `{
		"skills": ["private-pi/skills"],
		"prompts": ["prompts"],
		"supervisor": {"repo": "SchneiderDaniel/cheasee-pi"}
	}`
	os.MkdirAll(filepath.Dir(dest), 0755)
	if err := os.WriteFile(dest, []byte(input), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	gen := NewSettingsGenerator()
	vals := SettingsValues{GitHubUser: "testuser", RepoName: "cheasee-pi"}

	if err := gen.Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}

	var result map[string]any
	json.Unmarshal(data, &result)

	// skills should be empty (private-pi/skills removed)
	skills := result["skills"].([]any)
	if len(skills) != 0 {
		t.Errorf("expected empty skills, got %v", skills)
	}

	// prompts should be unchanged
	prompts := result["prompts"].([]any)
	if len(prompts) != 1 || prompts[0] != "prompts" {
		t.Errorf("expected prompts to be unchanged, got %v", prompts)
	}
}

func TestSettingsAdapter_GitHubUserEmpty(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	os.MkdirAll(filepath.Dir(dest), 0755)
	if err := os.WriteFile(dest, []byte(sampleSettingsJSON), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	gen := NewSettingsGenerator()
	vals := SettingsValues{
		GitHubUser: "",
		RepoName:   "cheasee-pi",
		SourceRepo: "SchneiderDaniel/cheasee-pi",
	}

	if err := gen.Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}

	var result map[string]any
	json.Unmarshal(data, &result)

	supervisor := result["supervisor"].(map[string]any)
	if repo := supervisor["repo"].(string); repo != "SchneiderDaniel/cheasee-pi" {
		t.Errorf("expected supervisor.repo 'SchneiderDaniel/cheasee-pi' (SourceRepo fallback), got %q", repo)
	}
}

func TestSettingsAdapter_RepoNameDefaults(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	os.MkdirAll(filepath.Dir(dest), 0755)
	if err := os.WriteFile(dest, []byte(sampleSettingsJSON), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	gen := NewSettingsGenerator()
	vals := SettingsValues{
		GitHubUser: "testuser",
		RepoName:   "",
	}

	if err := gen.Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}

	var result map[string]any
	json.Unmarshal(data, &result)

	supervisor := result["supervisor"].(map[string]any)
	if repo := supervisor["repo"].(string); repo != "testuser/cheasee-pi" {
		t.Errorf("expected supervisor.repo 'testuser/cheasee-pi', got %q", repo)
	}
}

func TestSettingsAdapter_OutputIsValidJSON(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	os.MkdirAll(filepath.Dir(dest), 0755)
	if err := os.WriteFile(dest, []byte(sampleSettingsJSON), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	gen := NewSettingsGenerator()
	vals := SettingsValues{GitHubUser: "testuser", RepoName: "cheasee-pi"}

	if err := gen.Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}

	// Must be parseable as JSON
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
}

func TestSettingsAdapter_GitHubUserTrimmed(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	os.MkdirAll(filepath.Dir(dest), 0755)
	if err := os.WriteFile(dest, []byte(sampleSettingsJSON), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	gen := NewSettingsGenerator()
	vals := SettingsValues{
		GitHubUser: "  testuser  ",
		RepoName:   "cheasee-pi",
	}

	if err := gen.Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}

	var result map[string]any
	json.Unmarshal(data, &result)

	supervisor := result["supervisor"].(map[string]any)
	if repo := supervisor["repo"].(string); repo != "testuser/cheasee-pi" {
		t.Errorf("expected supervisor.repo 'testuser/cheasee-pi', got %q (username should be trimmed)", repo)
	}
}

func TestSettingsAdapter_ExtraFieldsPassthrough(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	input := `{
		"_underscore_key": "should-pass",
		"nested": {"deep": {"value": true}},
		"skills": [".pi/skills"],
		"prompts": ["prompts"],
		"supervisor": {"repo": "SchneiderDaniel/cheasee-pi"}
	}`
	os.MkdirAll(filepath.Dir(dest), 0755)
	if err := os.WriteFile(dest, []byte(input), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	gen := NewSettingsGenerator()
	vals := SettingsValues{GitHubUser: "testuser", RepoName: "cheasee-pi"}

	if err := gen.Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}

	var result map[string]any
	json.Unmarshal(data, &result)

	if _, ok := result["_underscore_key"]; !ok {
		t.Error("_underscore_key should be preserved")
	}
	if _, ok := result["nested"]; !ok {
		t.Error("nested should be preserved")
	}
	if _, ok := result["docker"]; ok {
		t.Error("docker should NOT be in output (was not in input)")
	}
}

func TestSettingsAdapter_MissingSupervisorBlock(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	input := `{
		"skills": [".pi/skills"],
		"prompts": ["prompts"]
	}`
	os.MkdirAll(filepath.Dir(dest), 0755)
	if err := os.WriteFile(dest, []byte(input), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	gen := NewSettingsGenerator()
	vals := SettingsValues{GitHubUser: "testuser", RepoName: "cheasee-pi"}

	if err := gen.Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}

	var result map[string]any
	json.Unmarshal(data, &result)

	supervisor, ok := result["supervisor"].(map[string]any)
	if !ok {
		t.Fatal("supervisor should be created when missing")
	}
	if repo := supervisor["repo"].(string); repo != "testuser/cheasee-pi" {
		t.Errorf("expected supervisor.repo 'testuser/cheasee-pi', got %q", repo)
	}
}

func TestSettingsAdapter_MissingSkillsPrompts(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	input := `{"supervisor": {"repo": "SchneiderDaniel/cheasee-pi"}}`
	os.MkdirAll(filepath.Dir(dest), 0755)
	if err := os.WriteFile(dest, []byte(input), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	gen := NewSettingsGenerator()
	vals := SettingsValues{GitHubUser: "testuser", RepoName: "cheasee-pi"}

	if err := gen.Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	data, err := os.ReadFile(dest)
	_ = data
	if err != nil {
		t.Fatalf("read output: %v", err)
	}
	// Should complete without error — missing keys are optional
}

// ──────────────────────────────────────────────
// Entity: SettingsValues zero values
// ──────────────────────────────────────────────

func TestSettingsValues_ZeroValues(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".pi", "settings.json")

	input := `{"supervisor": {"repo": "original"}}`
	os.MkdirAll(filepath.Dir(dest), 0755)
	if err := os.WriteFile(dest, []byte(input), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	gen := NewSettingsGenerator()
	vals := SettingsValues{}

	if err := gen.Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render with zero values should not panic: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}

	var result map[string]any
	json.Unmarshal(data, &result)

	supervisor := result["supervisor"].(map[string]any)
	// GitHubUser="" (empty) but RepoName defaults to "cheasee-pi"
	// Since GitHubUser is empty, SourceRepo is also empty — so repo becomes ""
	if repo := supervisor["repo"].(string); repo != "" {
		t.Errorf("expected empty repo for empty values, got %q", repo)
	}
}
