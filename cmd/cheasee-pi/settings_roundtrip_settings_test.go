package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestSettingsSave_createsParentDirsNoTmpResidue(t *testing.T) {
	workdir := t.TempDir()
	if err := fullSchema.Save(workdir); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	path := filepath.Join(workdir, ".pi", "settings.json")
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("settings.json missing: %v", err)
	}
	if fi.Mode().Perm() != 0644 {
		t.Errorf("settings.json mode = %v, want 0644", fi.Mode().Perm())
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Error("no .tmp file should remain after Save")
	}
}

func TestSettingsSave_unwritableDirErrorsNoPartialFile(t *testing.T) {
	workdir := t.TempDir()
	if err := os.Mkdir(filepath.Join(workdir, ".pi"), 0555); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(filepath.Join(workdir, ".pi"), 0755)

	err := fullSchema.Save(workdir)
	if err == nil {
		t.Fatal("expected error writing into read-only .pi dir, got nil")
	}
	if _, statErr := os.Stat(filepath.Join(workdir, ".pi", "settings.json")); !os.IsNotExist(statErr) {
		t.Error("target file must be absent after failed Save (no partial write)")
	}
}

// ──────────────────────────────────────────────
// Load failure modes (adapter)
// ──────────────────────────────────────────────

func TestLoadSettings_missingFile(t *testing.T) {
	workdir := t.TempDir()
	_, err := LoadSettings(workdir)
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing settings.json: want os.ErrNotExist, got %v", err)
	}
}

func TestLoadSettings_missingPiDir(t *testing.T) {
	workdir := t.TempDir()
	_, err := LoadSettings(workdir)
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing .pi dir: want os.ErrNotExist, got %v", err)
	}
}

func TestLoadSettings_corruptJSON(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteSettingsFile(t, workdir, "{invalid json")
	if _, err := LoadSettings(workdir); err == nil {
		t.Fatal("expected error for corrupt JSON, got nil")
	}
}

func TestLoadSettings_typeMismatch(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteSettingsFile(t, workdir, `{"docker": {"memory": 4096}}`)
	if _, err := LoadSettings(workdir); err == nil {
		t.Fatal("expected error for docker.memory as number, got nil")
	}
}

func TestLoadSettings_nonObjectJSON(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteSettingsFile(t, workdir, `[1,2]`)
	if _, err := LoadSettings(workdir); err == nil {
		t.Fatal("expected error for non-object JSON, got nil")
	}
}

func TestLoadSettings_nullJSON(t *testing.T) {
	// The JSON literal null unmarshals cleanly into both the typed struct and
	// the raw map (leaving the map nil), so it must be rejected explicitly:
	// a null .pi/settings.json is a hard error, never an empty schema that a
	// subsequent Save silently overwrites.
	workdir := t.TempDir()
	testutil.WriteSettingsFile(t, workdir, `null`)
	if _, err := LoadSettings(workdir); err == nil {
		t.Fatal("expected error for null JSON, got nil")
	}
}

func TestLoadSettings_emptyObject(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteSettingsFile(t, workdir, `{}`)
	s, err := LoadSettings(workdir)
	if err != nil {
		t.Fatalf("empty {} must load without error, got %v", err)
	}
	if s.DefaultProvider != "" || s.Docker.Memory != "" {
		t.Errorf("empty {} must yield zero-value Settings, got %+v", s)
	}
}

func TestLoadSettings_preservesUnknownAndCaseVariantKeys(t *testing.T) {
	workdir := t.TempDir()
	// encoding/json accepts case-variant keys. Preserve all other pi and
	// extension settings when cheasee-pi later updates its provider fields.
	testutil.WriteSettingsFile(t, workdir, `{"DefaultProvider":"openai","futureKey":42,"supervisor":{"repo":"owner/repo"}}`)
	s, err := LoadSettings(workdir)
	if err != nil {
		t.Fatalf("case-variant/unknown keys must load, got %v", err)
	}
	if s.DefaultProvider != "openai" {
		t.Errorf("DefaultProvider = %q, want openai (case-insensitive key match)", s.DefaultProvider)
	}
	if err := s.Save(workdir); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(workdir, ".pi", "settings.json"))
	if !strings.Contains(string(data), "futureKey") || !strings.Contains(string(data), "supervisor") || !strings.Contains(string(data), `"repo": "owner/repo"`) {
		t.Errorf("Save lost unknown settings: %s", data)
	}
}
