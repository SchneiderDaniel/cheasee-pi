package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestCacheDir_underUserCacheDir verifies CacheDir resolves under
// os.UserCacheDir (XDG_CACHE_HOME honored on Unix) keyed by CLI version.
func TestCacheDir_underUserCacheDir(t *testing.T) {
	xdg := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", xdg)

	dir, err := CacheDir()
	if err != nil {
		t.Fatalf("CacheDir: %v", err)
	}
	want := filepath.Join(xdg, "cheasee-pi", cliVersionKey)
	if dir != want {
		t.Errorf("CacheDir = %q, want %q", dir, want)
	}
}

// TestCacheDir_versionKeyed asserts the version is the last path component —
// a different CLI version resolves to a different dir (no stale mixing).
func TestCacheDir_versionKeyed(t *testing.T) {
	xdg := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", xdg)

	dir, err := CacheDir()
	if err != nil {
		t.Fatalf("CacheDir: %v", err)
	}
	if filepath.Base(dir) != cliVersionKey {
		t.Errorf("cache dir must be keyed by CLI version, base = %q", filepath.Base(dir))
	}
	if filepath.Base(filepath.Dir(dir)) != "cheasee-pi" {
		t.Errorf("cache dir must live under cheasee-pi/, got %q", filepath.Dir(dir))
	}
}

func TestEnsureCacheDir_createsIdempotently(t *testing.T) {
	xdg := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", xdg)

	dir, err := ensureCacheDir(context.Background())
	if err != nil {
		t.Fatalf("ensureCacheDir: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("cache dir not created: %v", err)
	}
	// Idempotent second call.
	again, err := ensureCacheDir(context.Background())
	if err != nil {
		t.Fatalf("second ensureCacheDir: %v", err)
	}
	if again != dir {
		t.Errorf("second call returned %q, want %q", again, dir)
	}
}

func TestEnsureCacheDir_cancelledContextNoPartialDirs(t *testing.T) {
	xdg := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", xdg)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled

	_, err := ensureCacheDir(ctx)
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
	if !strings.Contains(err.Error(), "context") {
		t.Errorf("error should mention context: %v", err)
	}
	// Nothing created.
	if _, statErr := os.Stat(filepath.Join(xdg, "cheasee-pi")); !os.IsNotExist(statErr) {
		t.Error("cancelled ensureCacheDir must not create partial dirs")
	}
}

func TestCacheDir_neverInsideUserRepo(t *testing.T) {
	xdg := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", xdg)

	repo := t.TempDir() // a user repo
	dir, err := CacheDir()
	if err != nil {
		t.Fatal(err)
	}
	rel, err := filepath.Rel(repo, dir)
	if err == nil && !strings.HasPrefix(rel, "..") {
		t.Errorf("cache dir %q must not live inside user repo %q", dir, repo)
	}
	if !strings.HasPrefix(dir, xdg) {
		t.Errorf("cache dir %q must live under the user cache dir %q", dir, xdg)
	}
}
