package main

import (
	"context"
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

func loadAuthJSON(t *testing.T) *Auth {
	t.Helper()
	cfg := &fileRepository{}
	auth, err := cfg.Load(context.Background())
	if err != nil {
		t.Fatalf("load auth.json: %v", err)
	}
	return auth
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
