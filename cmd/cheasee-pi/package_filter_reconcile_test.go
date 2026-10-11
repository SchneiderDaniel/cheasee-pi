package main

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestReconcileDefaultPackageFilters_AbsentFileIsNoOp(t *testing.T) {
	dir := t.TempDir()
	if err := reconcileDefaultPackageFilters(dir); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if _, err := os.Stat(settingsPath(dir)); !os.IsNotExist(err) {
		t.Errorf("start must not scaffold .pi/settings.json, got: %v", err)
	}
}

func TestReconcileDefaultPackageFilters_SeedsMissingPackagesKey(t *testing.T) {
	dir := t.TempDir()
	writeRawSettings(t, dir, `{
	"defaultProvider": "anthropic",
	"docker": {"memory": "5G", "cpus": "4.0"},
	"gitIdentity": {"name": "N", "email": "e@example.com"},
	"handAdded": {"nested": [1, 2]}
}`)
	if err := reconcileDefaultPackageFilters(dir); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	entries := readPackages(t, dir)
	if len(entries) != 1 {
		t.Fatalf("expected one seeded entry, got %d: %s", len(entries), entries)
	}
	assertDefaultFilterObject(t, entries[0])

	s, err := LoadSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.DefaultProvider != "anthropic" || s.Docker.Memory != "5G" || s.Docker.CPUs != "4.0" || s.GitIdentity.Name != "N" {
		t.Errorf("pre-existing keys must be preserved, got %+v", s)
	}
	if got := string(s.extra["handAdded"]); !jsonEqual(t, got, `{"nested": [1, 2]}`) {
		t.Errorf("unknown key must be preserved, got %s", got)
	}
}

func TestReconcileDefaultPackageFilters_UpgradesBareString(t *testing.T) {
	dir := t.TempDir()
	writeRawSettings(t, dir, `{
	"packages": [
		"https://github.com/DietrichGebert/ponytail",
		"https://github.com/SchneiderDaniel/private-pi"
	],
	"theme": "cheasee-pi"
}`)
	if err := reconcileDefaultPackageFilters(dir); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	entries := readPackages(t, dir)
	if len(entries) != 2 {
		t.Fatalf("expected the two packages kept, got %d: %s", len(entries), entries)
	}
	assertDefaultFilterObject(t, entries[0])
	if !isBarePackageString(entries[1], "https://github.com/SchneiderDaniel/private-pi") {
		t.Errorf("non-default entry must stay a bare string, got %s", entries[1])
	}
	s, err := LoadSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.Theme != "cheasee-pi" {
		t.Errorf("theme must be preserved, got %q", s.Theme)
	}
}

func TestReconcileDefaultPackageFilters_ObjectEntryNotWritten(t *testing.T) {
	dir := t.TempDir()
	// Canonical input via Settings.Save: the filter policy is already applied.
	s := &Settings{Theme: "cheasee-pi", extra: map[string]json.RawMessage{
		"packages": json.RawMessage(`["https://github.com/SchneiderDaniel/private-pi",{"source":"https://github.com/DietrichGebert/ponytail","skills":["!ponytail-*"]}]`),
	}}
	if err := s.Save(dir); err != nil {
		t.Fatal(err)
	}
	before := readSettingsBytes(t, dir)
	stamp := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(settingsPath(dir), stamp, stamp); err != nil {
		t.Fatal(err)
	}

	if err := reconcileDefaultPackageFilters(dir); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	if got := readSettingsBytes(t, dir); !bytes.Equal(before, got) {
		t.Errorf("filtered object entry must be byte-identical:\n before=%s\n after =%s", before, got)
	}
	fi, err := os.Stat(settingsPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if !fi.ModTime().Equal(stamp) {
		t.Errorf("unchanged settings must not be rewritten, mtime moved to %v", fi.ModTime())
	}
}

func TestReconcileDefaultPackageFilters_HandEditedVariantUntouched(t *testing.T) {
	for _, variant := range []string{
		"https://github.com/DietrichGebert/ponytail.git",
		"https://github.com/DietrichGebert/ponytail@v1.2.3",
	} {
		t.Run(variant, func(t *testing.T) {
			dir := t.TempDir()
			writeRawSettings(t, dir, `{"packages": ["`+variant+`"]}`)
			before := readSettingsBytes(t, dir)

			if err := reconcileDefaultPackageFilters(dir); err != nil {
				t.Fatalf("reconcile: %v", err)
			}

			got := readSettingsBytes(t, dir)
			if !bytes.Equal(before, got) {
				t.Errorf("hand-edited variant must be left untouched (no duplicate entry):\n before=%s\n after =%s", before, got)
			}
		})
	}
}

func TestReconcileDefaultPackageFilters_AppendsWhenDefaultAbsent(t *testing.T) {
	dir := t.TempDir()
	writeRawSettings(t, dir, `{"packages": ["https://github.com/SchneiderDaniel/private-pi"], "theme": "cheasee-pi"}`)
	if err := reconcileDefaultPackageFilters(dir); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	entries := readPackages(t, dir)
	if len(entries) != 2 {
		t.Fatalf("expected default object appended, got %d: %s", len(entries), entries)
	}
	if !isBarePackageString(entries[0], "https://github.com/SchneiderDaniel/private-pi") {
		t.Errorf("existing entry must be byte-preserved, got %s", entries[0])
	}
	assertDefaultFilterObject(t, entries[1])
}
