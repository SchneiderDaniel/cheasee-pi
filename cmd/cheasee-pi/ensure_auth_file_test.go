package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 3: ensureAuthFile — the start gate
//
// Compose builds the credential mount with CreateMountpoint:false, so a missing
// source fails at container start with an opaque bind error. The CLI fails
// closed first, with the recovery command.
// ──────────────────────────────────────────────

func TestEnsureAuthFile_PresentOK(t *testing.T) {
	path := writeTempAuthFile(t, `{"github_token":"`+FakeGitHubToken+`"}`)
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	if err := ensureAuthFile(path); err != nil {
		t.Fatalf("present credential file must pass the gate, got %v", err)
	}

	after, err := os.Stat(path)
	if err != nil {
		t.Fatalf("the gate must not touch the file: %v", err)
	}
	if after.Mode() != before.Mode() {
		t.Errorf("mode changed: %v → %v", before.Mode(), after.Mode())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"github_token":"` + FakeGitHubToken + `"}`; string(data) != want {
		t.Errorf("content changed: %q, want %q", data, want)
	}
}

func TestEnsureAuthFile_MissingFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cheasee-pi", "auth.json")
	err := ensureAuthFile(path)
	if err == nil {
		t.Fatal("missing credential file must fail closed")
	}
	if !strings.Contains(err.Error(), path) {
		t.Errorf("error must name the missing path %q, got %v", path, err)
	}
	if !strings.Contains(err.Error(), "cheasee-pi auth") {
		t.Errorf("error must name the recovery command `cheasee-pi auth`, got %v", err)
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Errorf("the gate must never create the file, stat err = %v", statErr)
	}
}

func TestEnsureAuthFile_DirectoryAtPathErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cheasee-pi", "auth.json")
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	err := ensureAuthFile(path)
	if err == nil {
		t.Fatal("a directory at the credential path must be surfaced, not accepted")
	}
	if !strings.Contains(err.Error(), path) {
		t.Errorf("error must name the offending path %q, got %v", path, err)
	}
}

func TestEnsureAuthFile_UnreadableErrors(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: mode 0000 is still readable")
	}
	path := writeTempAuthFile(t, `{"github_token":"`+FakeGitHubToken+`"}`)
	if err := os.Chmod(path, 0000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0600) })

	if err := ensureAuthFile(path); err == nil {
		t.Fatal("an unreadable credential file must be surfaced (the container could not read it either)")
	}
}

func TestEnsureAuthFile_EmptyOrMalformedFileOK(t *testing.T) {
	// The gate is an EXISTENCE/readability gate only: parsing belongs to the
	// readers (fileRepository, ui auth.rs, entrypoint jq), each of which
	// surfaces its own parse error. A half-written auth.json must not block
	// start with a misleading "run cheasee-pi auth" hint.
	cases := map[string]string{
		"zero-byte":      "",
		"invalid-json":   "{not json",
		"missing-token":  `{"anthropic":{"key":"` + FakeAPIKey + `"}}`,
		"trailing-comma": `{"github_token":"` + FakeGitHubToken + `",}`,
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			path := writeTempAuthFile(t, content)
			if err := ensureAuthFile(path); err != nil {
				t.Errorf("existence gate must not parse the file, got %v", err)
			}
		})
	}
}
