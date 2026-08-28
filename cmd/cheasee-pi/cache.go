package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// CacheDir returns the version-keyed cache directory for CLI-managed assets:
// <os.UserCacheDir>/cheasee-pi/<cliVersion>. Keying by CLI version means an
// upgraded binary never mixes new compose/Dockerfile content with stale cache
// state (act/gh precedent). os.UserCacheDir honors
// $XDG_CACHE_HOME on Unix, $HOME/Library/Caches on Darwin and %LocalAppData%
// on Windows — never a hardcoded ~/.cache.
func CacheDir() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("user cache dir: %w", err)
	}
	return filepath.Join(base, "cheasee-pi", cliVersion()), nil
}

// cliVersionKey is the cache-dir key: the CLI's own semver. Kept as a const
// (referenced by rootCmd.Version too) so the cache path never participates in
// a rootCmd initialization cycle.
const cliVersionKey = "0.55.2"

// cliVersion is the cache-dir key: the CLI's own semver.
func cliVersion() string {
	return cliVersionKey
}

// ensureCacheDir resolves the version-keyed cache dir, creating it if
// missing. A single MkdirAll call means a cancelled context leaves no
// partial tree. The cache dir never lives inside the user repo.
func ensureCacheDir(ctx context.Context) (string, error) {
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	default:
	}
	dir, err := CacheDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("create cache dir %s: %w", dir, err)
	}
	return dir, nil
}
