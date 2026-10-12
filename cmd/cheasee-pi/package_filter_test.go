package main

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Shared fixtures
// ──────────────────────────────────────────────

// writeRawSettings writes .pi/settings.json verbatim (no canonicalization) so
// each reconcile branch gets the exact input shape it targets.
func writeRawSettings(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".pi"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settingsPath(dir), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func readSettingsBytes(t *testing.T, dir string) []byte {
	t.Helper()
	data, err := os.ReadFile(settingsPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// readPackages returns the raw packages[] elements of .pi/settings.json.

func readPackages(t *testing.T, dir string) []json.RawMessage {
	t.Helper()
	s, err := LoadSettings(dir)
	if err != nil {
		t.Fatalf("load settings: %v", err)
	}
	raw, ok := s.extra["packages"]
	if !ok {
		t.Fatalf("no packages key in %s: %s", settingsPath(dir), readSettingsBytes(t, dir))
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatalf("packages: %v", err)
	}
	return entries
}

// assertDefaultFilterObject fails unless entry is the object form carrying the
// default source and the exact skills filter.

func assertDefaultFilterObject(t *testing.T, entry json.RawMessage) {
	t.Helper()
	var obj packageFilterObject
	if err := json.Unmarshal(entry, &obj); err != nil {
		t.Fatalf("entry is not an object (%s): %v", entry, err)
	}
	if obj.Source != defaultSkillRepos[0] {
		t.Errorf("source = %q, want %q", obj.Source, defaultSkillRepos[0])
	}
	if len(obj.Skills) != 1 || obj.Skills[0] != "!ponytail-*" {
		t.Errorf("skills = %v, want [!ponytail-*]", obj.Skills)
	}
}

func isBarePackageString(entry json.RawMessage, want string) bool {
	var s string
	return json.Unmarshal(entry, &s) == nil && s == want
}

// jsonEqual compares two JSON documents by value. Unknown extra keys survive
// Load → mutate → Save with their value intact, but a hand-edited file's
// incidental whitespace is normalized by the shared re-indenting encoder.

func jsonEqual(t *testing.T, got, want string) bool {
	t.Helper()
	var a, b any
	if err := json.Unmarshal([]byte(got), &a); err != nil {
		t.Fatalf("unmarshal %s: %v", got, err)
	}
	if err := json.Unmarshal([]byte(want), &b); err != nil {
		t.Fatalf("unmarshal %s: %v", want, err)
	}
	return reflect.DeepEqual(a, b)
}

// ──────────────────────────────────────────────
// Phase 1: filter policy (entity)
// ──────────────────────────────────────────────

func TestDefaultPackageFilters_Policy(t *testing.T) {
	if len(defaultPackageFilters) != 1 {
		t.Fatalf("expected exactly one default package filter, got %d: %+v", len(defaultPackageFilters), defaultPackageFilters)
	}
	f := defaultPackageFilters[0]
	if f.Source != defaultSkillRepos[0] {
		t.Errorf("filter source %q must be defaultSkillRepos[0] %q", f.Source, defaultSkillRepos[0])
	}
	if len(f.Skills) != 1 || f.Skills[0] != "!ponytail-*" {
		t.Errorf("filter skills = %v, want [!ponytail-*]", f.Skills)
	}
}

func TestDefaultPackageFilters_GlobKeepsCoreDropsAux(t *testing.T) {
	// pi strips the leading "!" and matches the skill's parent directory name
	// (matchesAnyPattern on SKILL.md), so the bare glob is the whole pattern.
	pattern := strings.TrimPrefix(defaultPackageFilters[0].Skills[0], "!")
	if pattern == "" {
		t.Fatalf("filter %q has no glob after the leading !", defaultPackageFilters[0].Skills[0])
	}
	for _, name := range []string{"ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"} {
		ok, err := path.Match(pattern, name)
		if err != nil || !ok {
			t.Errorf("pattern %q must exclude %q (match=%v err=%v)", pattern, name, ok, err)
		}
	}
	if ok, err := path.Match(pattern, "ponytail"); err != nil || ok {
		t.Errorf("pattern %q must keep core ponytail (match=%v err=%v)", pattern, ok, err)
	}
}

// ──────────────────────────────────────────────
// Phase 2: reconcileDefaultPackageFilters (adapter)
// ──────────────────────────────────────────────
