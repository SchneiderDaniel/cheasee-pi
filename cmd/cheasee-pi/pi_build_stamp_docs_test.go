package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestVerifyScript_StampViaComposeEnv: the manual cache-verification script
// must supply PI_BUILD_STAMP through the compose env (the CLI seam), not as a
// global `--build-arg` — a global arg reaches every service again.
func TestVerifyScript_StampViaComposeEnv(t *testing.T) {
	src := readRepoFile(t, filepath.Join("scripts", "verify-pi-layer-cache.sh"))
	if strings.Contains(src, "--build-arg") {
		t.Error("verify script must not pass a global --build-arg (the compose env owns the stamp)")
	}
	if !strings.Contains(src, "PI_BUILD_STAMP=") {
		t.Error("verify script must inject PI_BUILD_STAMP via the compose env")
	}
}

// TestDocs_PiVersionPinnedDefault: docs must describe the concrete pinned
// default and `PI_VERSION=latest` as the explicit override — never an
// unconditional @latest install.
func TestDocs_PiVersionPinnedDefault(t *testing.T) {
	for _, rel := range []string{"installation.md", "daily-usage.md"} {
		src := readRepoFile(t, filepath.Join("docs", rel))
		if !strings.Contains(src, "PI_VERSION=latest") {
			t.Errorf("docs/%s must document PI_VERSION=latest as the explicit override", rel)
		}
		if strings.Contains(src, "as `@latest`") || strings.Contains(src, "`@latest` via") {
			t.Errorf("docs/%s must not describe pi as unconditionally @latest", rel)
		}
	}
}

func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	path := filepath.Join("..", "..", rel)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", rel, err)
	}
	return string(data)
}
