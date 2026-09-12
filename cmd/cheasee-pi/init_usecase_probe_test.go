package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestInitProbe_Empty(t *testing.T) {
	mode, err := runInitProbe(t.TempDir(), false)
	if err != nil {
		t.Fatalf("empty dir must proceed, got: %v", err)
	}
	if mode != initModeFull {
		t.Errorf("empty dir without --reauth must select the full flow, got %v", mode)
	}
}

func TestInitProbe_DSStoreOnlyProceeds(t *testing.T) {
	// Finder-touched folders (.DS_Store only) auto-init.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".DS_Store"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	mode, err := runInitProbe(dir, false)
	if err != nil {
		t.Fatalf(".DS_Store-only dir must proceed, got: %v", err)
	}
	if mode != initModeFull {
		t.Errorf("expected full mode, got %v", mode)
	}
}

func TestInitProbe_NonEmptyRefuses(t *testing.T) {
	// Hard refusal — no confirm prompt, no re-apply question.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := runInitProbe(dir, false)
	if err == nil || !strings.Contains(err.Error(), "empty folder") {
		t.Fatalf("non-empty dir must refuse with an empty-folder-only error, got: %v", err)
	}
	if !strings.Contains(err.Error(), "file.txt") {
		t.Errorf("refusal should name the offending entry, got: %v", err)
	}
}

func TestInitProbe_SettingsPresentRefuses(t *testing.T) {
	// cheasee-settings.json presence = initialized marker — no re-apply prompt.
	dir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, dir, `{"defaultProvider": "openai"}`)
	_, err := runInitProbe(dir, false)
	if err == nil || !strings.Contains(err.Error(), "already initialized") {
		t.Fatalf("settings present must refuse as already initialized, got: %v", err)
	}
	if !strings.Contains(err.Error(), "cheasee-pi start") {
		t.Errorf("refusal should point at `cheasee-pi start`, got: %v", err)
	}
	if !strings.Contains(err.Error(), "--reauth") {
		t.Errorf("refusal should name `--reauth`, got: %v", err)
	}
}

func TestInitProbe_SettingsPresentWithReauthSelectsReauth(t *testing.T) {
	dir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, dir, `{}`)
	mode, err := runInitProbe(dir, true)
	if err != nil {
		t.Fatalf("settings present + --reauth must proceed, got: %v", err)
	}
	if mode != initModeReauth {
		t.Errorf("expected reauth mode, got %v", mode)
	}
}

func TestInitProbe_SettingsPresentWithReauthSkipsEmptyFolderProbe(t *testing.T) {
	// On an initialized workspace the empty-folder probe is skipped — the
	// workspace has files by design.
	dir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, dir, `{}`)
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	mode, err := runInitProbe(dir, true)
	if err != nil {
		t.Fatalf("settings present + --reauth must skip the empty-folder probe, got: %v", err)
	}
	if mode != initModeReauth {
		t.Errorf("expected reauth mode, got %v", mode)
	}
}

func TestInitProbe_ReauthInertWithoutSettings(t *testing.T) {
	// --reauth without settings: flag is inert — full mode on empty dirs,
	// unchanged empty-folder refusal on non-empty dirs.
	empty := t.TempDir()
	mode, err := runInitProbe(empty, true)
	if err != nil {
		t.Fatalf("--reauth on an empty dir without settings must proceed full, got: %v", err)
	}
	if mode != initModeFull {
		t.Errorf("expected full mode, got %v", mode)
	}

	nonEmpty := t.TempDir()
	if err := os.WriteFile(filepath.Join(nonEmpty, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := runInitProbe(nonEmpty, true); err == nil || !strings.Contains(err.Error(), "empty folder") {
		t.Fatalf("--reauth without settings on a non-empty dir must keep the empty-folder refusal, got: %v", err)
	}
}

func TestInitProbe_SettingsPresentBeatsEmptyFolderProbe(t *testing.T) {
	// The marker branch precedes the empty branch in the mapping: an
	// initialized workspace with stray files refuses as "already initialized",
	// never as "not empty".
	dir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, dir, `{}`)
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := runInitProbe(dir, false)
	if err == nil || !strings.Contains(err.Error(), "already initialized") {
		t.Fatalf("settings present must refuse as already initialized, got: %v", err)
	}
	if strings.Contains(err.Error(), "empty folder") {
		t.Errorf("settings present must not trigger the empty-folder probe, got: %v", err)
	}
}

func TestInitProbe_BrokenPathInspectFolderError(t *testing.T) {
	// A workdir that can't be inspected surfaces the ReadDir wrapper.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "somefile.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := runInitProbe(filepath.Join(dir, "somefile.txt", "sub"), false)
	if err == nil || !strings.Contains(err.Error(), "inspect folder:") {
		t.Fatalf("broken workdir must surface inspect-folder error, got: %v", err)
	}
}
