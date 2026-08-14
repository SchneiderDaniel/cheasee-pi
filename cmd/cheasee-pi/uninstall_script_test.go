package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// uninstallScriptPath is the standalone scripts/uninstall.sh relative to this
// package dir (tests run from cmd/cheasee-pi/).
func uninstallScriptPath() string {
	return filepath.Join("..", "..", "scripts", "uninstall.sh")
}

// TestUninstallScript_DryRunMatchesGoPaths pins the standalone uninstall
// script's --dry-run deletion list to the Go-computed paths it must mirror
// (cache parent, auth config, binary). The script removes the whole
// <cache>/cheasee-pi/ parent while Go removes only the current version
// key — this intentional divergence is what the test locks in.
func TestUninstallScript_DryRunMatchesGoPaths(t *testing.T) {
	script := uninstallScriptPath()
	if _, err := os.Stat(script); err != nil {
		t.Fatalf("scripts/uninstall.sh missing: %v", err)
	}

	tmp := t.TempDir()
	home := filepath.Join(tmp, "home")
	cacheBase := filepath.Join(tmp, "cache")
	configBase := filepath.Join(tmp, "config")
	binDir := filepath.Join(tmp, "bin")
	for _, d := range []string{home, cacheBase, configBase, binDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}

	// Install-state fixture: cache parent with two version keys, auth.json,
	// and a dummy binary on PATH. (Workspace .pi/.git must never appear.)
	cacheParent := filepath.Join(cacheBase, "cheasee-pi")
	for _, v := range []string{"0.49", "0.50"} {
		if err := os.MkdirAll(filepath.Join(cacheParent, v), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", filepath.Join(cacheParent, v), err)
		}
	}
	authPath := filepath.Join(configBase, "cheasee-pi", "auth.json")
	if err := os.MkdirAll(filepath.Dir(authPath), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(authPath), err)
	}
	if err := os.WriteFile(authPath, []byte("{}\n"), 0o600); err != nil {
		t.Fatalf("write %s: %v", authPath, err)
	}
	binary := filepath.Join(binDir, "cheasee-pi")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write %s: %v", binary, err)
	}

	t.Setenv("HOME", home)
	t.Setenv("XDG_CACHE_HOME", cacheBase)
	t.Setenv("XDG_CONFIG_HOME", configBase)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	cmd := exec.Command("bash", script, "--dry-run", "--force")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("uninstall.sh --dry-run failed: %v\n%s", err, out)
	}

	got := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "will remove ") {
			got[strings.TrimSpace(strings.TrimPrefix(trimmed, "will remove "))] = true
		}
	}

	want := map[string]bool{
		filepath.Dir(mustCacheDir(t)): true, // whole cache parent (all version keys)
		authPath:                      true,
		binary:                        true,
	}
	if len(got) != len(want) {
		t.Errorf("dry-run listed %d paths, want %d\nlisted: %v", len(got), len(want), got)
	}
	for p := range want {
		if !got[p] {
			t.Errorf("dry-run list missing %q (listed: %v)", p, got)
		}
	}
	// Dry run must not delete anything.
	for _, p := range []string{filepath.Join(cacheParent, "0.49"), authPath, binary} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("dry-run deleted %s: %v", p, err)
		}
	}
}

// mustCacheDir returns CacheDir(), failing the test on resolution error.
func mustCacheDir(t *testing.T) string {
	t.Helper()
	dir, err := CacheDir()
	if err != nil {
		t.Fatalf("CacheDir: %v", err)
	}
	return dir
}
