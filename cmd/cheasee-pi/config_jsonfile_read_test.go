package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// readJSONFile / writeJSONFile generic primitives
// ──────────────────────────────────────────────

func TestReadJSONFile_MissingFileNotFoundVTouched(t *testing.T) {
	testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	v := map[string]json.RawMessage{"keep": json.RawMessage(`"me"`)}
	found, err := cfg.readJSONFile(&v)
	if err != nil || found {
		t.Fatalf("missing file: (found, err) = (%v, %v), want (false, nil)", found, err)
	}
	if len(v) != 1 || string(v["keep"]) != `"me"` {
		t.Errorf("missing file: v must be untouched, got %v", v)
	}
}

func TestReadJSONFile_ValidFilePopulatesV(t *testing.T) {
	writeAuthFile(t, `{"openai":{"key":"k"},"github_token":"tok"}`)
	cfg := &fileRepository{}
	var v map[string]json.RawMessage
	found, err := cfg.readJSONFile(&v)
	if err != nil || !found {
		t.Fatalf("valid file: (found, err) = (%v, %v), want (true, nil)", found, err)
	}
	if got := string(v["github_token"]); got != `"tok"` {
		t.Errorf("github_token = %s, want \"tok\"", got)
	}
	var entry struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(v["openai"], &entry); err != nil || entry.Key != "k" {
		t.Errorf("openai entry = %+v (err %v), want key k", entry, err)
	}
}

func TestReadJSONFile_EmptyFileErrors(t *testing.T) {
	// Empty file ≠ missing file: fail-closed, a 0-byte auth.json must error
	// before any write could clobber it.
	writeAuthFile(t, "")
	cfg := &fileRepository{}
	var v map[string]json.RawMessage
	found, err := cfg.readJSONFile(&v)
	if err == nil {
		t.Errorf("0-byte auth.json must error (found=%v)", found)
	}
}

func TestReadJSONFile_MalformedErrors(t *testing.T) {
	writeAuthFile(t, `{invalid json}`)
	cfg := &fileRepository{}
	var v map[string]json.RawMessage
	if _, err := cfg.readJSONFile(&v); err == nil {
		t.Error("malformed JSON must error")
	}
}

func TestReadJSONFile_PathIsDirectoryErrors(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)
	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	cfg := &fileRepository{}
	var v map[string]json.RawMessage
	if _, err := cfg.readJSONFile(&v); err == nil {
		t.Error("auth.json as a directory must error (non-IsNotExist read failure surfaces)")
	}
}

func TestReadJSONFile_PrepopulatedVMerges(t *testing.T) {
	// populate-not-merge contract: file keys overwrite same-named memory
	// entries, memory-only keys survive. Callers must pass a fresh v.
	writeAuthFile(t, `{"b":"file-b","c":"file-c"}`)
	cfg := &fileRepository{}
	v := map[string]json.RawMessage{
		"a": json.RawMessage(`"mem-a"`),
		"b": json.RawMessage(`"mem-b"`),
	}
	found, err := cfg.readJSONFile(&v)
	if err != nil || !found {
		t.Fatalf("valid file: (found, err) = (%v, %v), want (true, nil)", found, err)
	}
	if got := string(v["a"]); got != `"mem-a"` {
		t.Errorf("memory-only key a = %s, want \"mem-a\"", got)
	}
	if got := string(v["b"]); got != `"file-b"` {
		t.Errorf("file key b must override memory entry, got %s, want \"file-b\"", got)
	}
	if got := string(v["c"]); got != `"file-c"` {
		t.Errorf("file key c = %s, want \"file-c\"", got)
	}
}
