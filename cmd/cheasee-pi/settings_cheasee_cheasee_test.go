package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestCheaseeSettingsPath_isFolderRoot(t *testing.T) {
	workdir := filepath.Join(t.TempDir(), "ws")
	if got := cheaseeSettingsPath(workdir); got != filepath.Join(workdir, "cheasee-settings.json") {
		t.Errorf("cheaseeSettingsPath = %q, want %q", got, filepath.Join(workdir, "cheasee-settings.json"))
	}
}

// ──────────────────────────────────────────────
// CheaseeSettings.skillRepos (custom skill repositories)
// ──────────────────────────────────────────────

func TestCheaseeSettings_skillReposRoundTrip(t *testing.T) {
	workdir := t.TempDir()
	s := &CheaseeSettings{
		DefaultProvider: "opencode-go",
		SkillRepos:      []string{"https://github.com/a/b", "git:github.com/c/d@v1"},
	}
	if err := s.Save(workdir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(loaded.SkillRepos) != 2 || loaded.SkillRepos[0] != "https://github.com/a/b" || loaded.SkillRepos[1] != "git:github.com/c/d@v1" {
		t.Errorf("round-trip mismatch: %v", loaded.SkillRepos)
	}
}

func TestCheaseeSettings_skillReposSaveByteStable(t *testing.T) {
	workdir := t.TempDir()
	s := &CheaseeSettings{SkillRepos: []string{"https://github.com/a/b", "git:github.com/c/d"}}
	if err := s.Save(workdir); err != nil {
		t.Fatalf("first Save: %v", err)
	}
	first, err := os.ReadFile(cheaseeSettingsPath(workdir))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Save(workdir); err != nil {
		t.Fatalf("second Save: %v", err)
	}
	second, err := os.ReadFile(cheaseeSettingsPath(workdir))
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Errorf("repeated Save with populated SkillRepos must be byte-identical:\nfirst:  %q\nsecond: %q", first, second)
	}
}

func TestCheaseeSettings_nilSkillReposOmitsKey(t *testing.T) {
	// nil SkillRepos (omitempty) must not emit a skillRepos key — the
	// existing fullCheaseeSchema round-trip/byte-stable tests stay green
	// unchanged.
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.SkillRepos) != 0 {
		t.Fatalf("empty {} must load with nil SkillRepos, got %v", s.SkillRepos)
	}
	if err := s.Save(workdir); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(cheaseeSettingsPath(workdir))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "skillRepos") {
		t.Errorf("Save of nil SkillRepos must not emit a skillRepos key, got: %s", data)
	}
}

func TestLoadCheaseeSettings_skillReposTypeError(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"skillRepos": "not-an-array"}`)
	if _, err := LoadCheaseeSettings(workdir); err == nil {
		t.Fatal("string skillRepos must be a hard type error")
	}
}

// ──────────────────────────────────────────────
// CheaseeSettings unknown-key preservation (extra round-trip)
// ──────────────────────────────────────────────

func TestCheaseeSettings_preservesUnknownAndCaseVariantKeys(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"DefaultProvider":"openai","theme":"dark","futureKey":42}`)
	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatalf("case-variant/unknown keys must load, got %v", err)
	}
	if s.DefaultProvider != "openai" {
		t.Errorf("DefaultProvider = %q, want openai (case-insensitive key match)", s.DefaultProvider)
	}
	if err := s.Save(workdir); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(cheaseeSettingsPath(workdir))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"theme", "futureKey", `"futureKey": 42`} {
		if !strings.Contains(string(data), want) {
			t.Errorf("Save lost unknown key %q: %s", want, data)
		}
	}
}

// TestCheaseeSettings_bannerKeySurvivesLoadSaveOnce asserts the documented
// "//" banner key (the JSON-comment workaround) survives Load → Save exactly
// once — never pruned, never duplicated.
