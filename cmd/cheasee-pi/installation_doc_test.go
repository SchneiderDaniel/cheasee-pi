package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// docPath is the path to the installation doc relative to this test file.
func docPath() string {
	// Test runs from the package directory (cmd/cheasee-pi/).
	return filepath.Join("..", "..", "docs", "installation.md")
}

// TestInstallationDoc_VersionMatchesRootCmd verifies that the VERSION
// placeholder in docs/installation.md matches rootCmd.Version.
func TestInstallationDoc_VersionMatchesRootCmd(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	// Find the VERSION assignment line in the Go CLI path section
	if !strings.Contains(content, `VERSION="`+rootCmd.Version+`"`) {
		t.Errorf("docs/installation.md should contain VERSION=%q matching rootCmd.Version (%q)", rootCmd.Version, rootCmd.Version)
	}
}

// TestInstallationDoc_NoIgnoreMissing verifies that Step 2 checksum command
// does NOT contain --ignore-missing (which silently passes on missing archives).
func TestInstallationDoc_NoIgnoreMissing(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	if strings.Contains(content, "--ignore-missing") {
		t.Error("Step 2 checksum command must NOT contain --ignore-missing (use strict verification)")
	}
}

// TestInstallationDoc_DownloadURLPattern verifies the curl URL pattern matches
// GoReleaser default archive naming: cheasee-pi_${VERSION}_${OS}_${ARCH}.tar.gz.
func TestInstallationDoc_DownloadURLPattern(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "cheasee-pi_${VERSION}_${OS}_${ARCH}.tar.gz") {
		t.Error("curl URL must use GoReleaser default naming: cheasee-pi_${VERSION}_${OS}_${ARCH}.tar.gz")
	}
}

// TestInstallationDoc_NoCheaseePiStart verifies Step 6 does NOT reference
// 'cheasee-pi start' (which does not exist) — it should reference docker compose.
func TestInstallationDoc_NoCheaseePiStart(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	if strings.Contains(content, "cheasee-pi start") {
		t.Error("Step 6 must NOT reference 'cheasee-pi start' (use 'docker compose ... up -d --build')")
	}
}

// TestInstallationDoc_GoCliPathVersion verifies the VERSION variable assignment
// in Step 1 is not a stale placeholder (0.1.0) and uses the resolved version.
func TestInstallationDoc_GoCliPathVersion(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	// The VERSION assignment should not be the stale placeholder
	if strings.Contains(content, `VERSION="0.1.0"`) {
		t.Error("VERSION in docs/installation.md is still the stale placeholder 0.1.0; update to match rootCmd.Version")
	}
}

// TestInstallationDoc_Path verifies that Step 5 bullet 8 of the installation
// doc matches the path that config.go:fileRepository.configPath() actually
// writes to — the XDG user config dir, not the legacy ~/.pi/agent/auth.json.
func TestInstallationDoc_Path(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	// The doc must use the XDG user config directory path (matches
	// filepath.Join(userConfigDir, "cheasee-pi", "auth.json") in config.go).
	if !strings.Contains(content, "cheasee-pi/auth.json") &&
		!strings.Contains(content, "cheasee-pi" + string(os.PathSeparator) + "auth.json") {
		t.Error("Step 5 bullet 8 should reference cheasee-pi/auth.json (XDG path suffix from config.go)")
	}

	// The doc must no longer contain the legacy shell-script path.
	if strings.Contains(content, "~/.pi/agent/auth.json") {
		t.Error("Step 5 bullet 8 should not contain the legacy path ~/.pi/agent/auth.json")
	}

	// The doc should reference the runtime confirmation line as the
	// authoritative source of the exact path.
	if !strings.Contains(content, "Auth config saved to") &&
		!strings.Contains(content, "✓ Auth config saved to") {
		t.Error("Step 5 bullet 8 should reference the runtime output \"✓ Auth config saved to...\"")
	}
}
