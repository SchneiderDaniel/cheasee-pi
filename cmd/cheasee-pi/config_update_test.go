package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestUpdateGitHubAuth_MalformedExistingErrorsWithoutOverwrite(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)
	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{invalid json}"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	cfg := &fileRepository{}
	err = cfg.UpdateGitHubAuth(context.Background(), "new-token", "octocat", "/ws")
	if err == nil {
		t.Fatal("expected error for malformed existing auth.json")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Error("malformed auth.json must not be overwritten")
	}
}

func TestUpdateGitHubAuth_AtomicWritePermsAndRoundTrip(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	if err := cfg.UpdateGitHubAuth(context.Background(), "new-token", "octocat", "/ws"); err != nil {
		t.Fatalf("UpdateGitHubAuth: %v", err)
	}

	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat auth.json: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Errorf("expected 0600 perms, got %v", info.Mode().Perm())
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Error("no .tmp file may remain after UpdateGitHubAuth")
	}

	token, err := cfg.GitHubToken(context.Background())
	if err != nil {
		t.Fatalf("GitHubToken round-trip: %v", err)
	}
	if token != "new-token" {
		t.Errorf("GitHubToken round-trip shows the new token, got %q", token)
	}
	raw := readAuthJSON(t)
	if got := authField(t, raw, "github_user"); got != "octocat" {
		t.Errorf("github_user = %q, want octocat", got)
	}
	if got := authField(t, raw, "repo_path"); got != "/ws" {
		t.Errorf("repo_path = %q, want /ws", got)
	}
	if providers, err := cfg.ListProviders(context.Background()); err != nil || len(providers) != 0 {
		t.Errorf("no providers should be present, got %v (err %v)", providers, err)
	}
}

// TestUpdateGitHubAuth_clampsWorldReadableAuthTo0600 is the audit regression
// for atomicWrite mode preservation: it must be opt-in, so a pre-existing
// world-readable auth.json (e.g. 0644 from an older tool or a chmod mistake)
// is clamped back to 0600 on the next credential write, never left readable.

func TestUpdateGitHubAuth_clampsWorldReadableAuthTo0600(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)
	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"github_token":"leaked"}`), 0644); err != nil {
		t.Fatal(err)
	}

	cfg := &fileRepository{}
	if err := cfg.UpdateGitHubAuth(context.Background(), "new-token", "octocat", "/ws"); err != nil {
		t.Fatalf("UpdateGitHubAuth: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat auth.json: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Errorf("auth.json must be clamped to 0600 after rewrite, got %v", info.Mode().Perm())
	}
}

// TestAtomicWrite_preservesExistingMode: rename replaces the inode, so a
// pre-existing chmod'd target must keep its mode across a rewrite; an absent
// target gets the caller's perm.

func TestAtomicWrite_preservesExistingMode(t *testing.T) {
	dir := t.TempDir()
	for _, want := range []os.FileMode{0600, 0640} {
		path := filepath.Join(dir, fmt.Sprintf("target-%o", want))
		if err := os.WriteFile(path, []byte("old"), want); err != nil {
			t.Fatal(err)
		}
		if err := atomicWrite(path, []byte("new"), 0644, true); err != nil {
			t.Fatalf("atomicWrite over %o: %v", want, err)
		}
		fi, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != want {
			t.Errorf("existing %o target must keep its mode after rewrite, got %v", want, fi.Mode().Perm())
		}
	}

	// Absent target gets the caller perm.
	path := filepath.Join(dir, "new-file")
	if err := atomicWrite(path, []byte("x"), 0644, true); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0644 {
		t.Errorf("absent target must get caller perm 0644, got %v", fi.Mode().Perm())
	}
}

// TestSettingsSave_preservesChmoddedMode: Settings.Save over a 0600
// .pi/settings.json preserves 0600 — no silent 0644 reset via the rename.
