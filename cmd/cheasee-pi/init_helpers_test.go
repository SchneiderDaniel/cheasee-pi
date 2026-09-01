package main

import (
	"encoding/json"
	"os"
	"testing"
)

func authJSONExists(t *testing.T) bool {
	t.Helper()
	cfg := &fileRepository{}
	p, err := cfg.Path()
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

// readAuthJSON returns the raw auth.json contents for the current config
// home decoded into a map, failing the test if the file is missing or
// malformed. The typed codec is gone, so tests read the raw-map dialect.
func readAuthJSON(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	cfg := &fileRepository{}
	path, err := cfg.Path()
	if err != nil {
		t.Fatalf("auth path: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read auth.json: %v", err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("parse auth.json: %v", err)
	}
	return raw
}

// authField returns the string value of a top-level auth.json field.
func authField(t *testing.T, raw map[string]json.RawMessage, key string) string {
	t.Helper()
	var s string
	if err := json.Unmarshal(raw[key], &s); err != nil {
		t.Fatalf("auth.json %q: %v", key, err)
	}
	return s
}

// providerKey returns the key of a provider entry ({"<provider>": {"key": …}})
// from a raw auth.json map.
func providerKey(t *testing.T, raw map[string]json.RawMessage, provider string) string {
	t.Helper()
	var entry struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(raw[provider], &entry); err != nil {
		t.Fatalf("auth.json provider %q: %v", provider, err)
	}
	return entry.Key
}

// authJSONBytes returns the raw auth.json contents for the current config
// home, failing the test if the file is missing.
func authJSONBytes(t *testing.T) []byte {
	t.Helper()
	cfg := &fileRepository{}
	path, err := cfg.Path()
	if err != nil {
		t.Fatalf("auth path: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read auth.json: %v", err)
	}
	return data
}
