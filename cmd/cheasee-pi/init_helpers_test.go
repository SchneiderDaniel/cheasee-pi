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
