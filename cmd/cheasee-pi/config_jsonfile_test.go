package main

import (
	"bytes"
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

func TestWriteJSONFile_RoundTripAndTwoSpaceIndent(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	raw := map[string]json.RawMessage{
		"github_token": json.RawMessage(`"tok-1"`),
		"openai":       json.RawMessage(`{"key":"k"}`),
	}
	if err := cfg.writeJSONFile(raw); err != nil {
		t.Fatalf("writeJSONFile: %v", err)
	}

	var v map[string]json.RawMessage
	found, err := cfg.readJSONFile(&v)
	if err != nil || !found {
		t.Fatalf("readback: (found, err) = (%v, %v), want (true, nil)", found, err)
	}
	if got := string(v["github_token"]); got != `"tok-1"` {
		t.Errorf("github_token = %s, want \"tok-1\"", got)
	}
	var entry struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(v["openai"], &entry); err != nil || entry.Key != "k" {
		t.Errorf("openai entry must round-trip logically, got %s (err %v)", v["openai"], err)
	}

	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte("\n  \"")) {
		t.Errorf("file must use 2-space indentation, got:\n%s", data)
	}
}

func TestWriteJSONFile_IdenticalContentByteIdentical(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	raw := map[string]json.RawMessage{
		"b": json.RawMessage(`"two"`),
		"a": json.RawMessage(`"one"`),
	}
	if err := cfg.writeJSONFile(raw); err != nil {
		t.Fatalf("first write: %v", err)
	}
	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	first, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.writeJSONFile(raw); err != nil {
		t.Fatalf("second write: %v", err)
	}
	second, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Errorf("identical content must produce byte-identical files:\nfirst:\n%s\nsecond:\n%s", first, second)
	}
}

func TestWriteJSONFile_UnmarshalableValueErrorsNoResidue(t *testing.T) {
	dir := testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	bad := map[string]any{"c": make(chan int)}
	if err := cfg.writeJSONFile(bad); err == nil {
		t.Fatal("chan value must fail json.Marshal")
	}
	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("no auth.json may be created for an unmarshalable value")
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Error("no .tmp may be left behind for an unmarshalable value")
	}
}

func TestReadRawMap_MissingFileNonNilEmptyMapFreshAlloc(t *testing.T) {
	testutil.RedirectConfigHome(t)
	cfg := &fileRepository{}
	raw, err := cfg.readRawMap()
	if err != nil {
		t.Fatalf("missing file: readRawMap err = %v, want nil", err)
	}
	if raw == nil {
		t.Fatal("missing file: readRawMap must return a non-nil empty map")
	}
	if len(raw) != 0 {
		t.Fatalf("missing file: readRawMap = %v, want empty", raw)
	}
	raw["mutate"] = json.RawMessage(`"x"`)
	fresh, err := cfg.readRawMap()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := fresh["mutate"]; ok {
		t.Error("each readRawMap call must return a fresh map (no cross-call contamination)")
	}
}
