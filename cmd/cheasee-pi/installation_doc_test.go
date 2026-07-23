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

// TestInstallationDoc_DownloadURLPattern verifies the doc contains a download
// URL pattern matching GoReleaser archive naming for any supported platform.
// linux/darwin use .tar.gz, windows uses .zip.
func TestInstallationDoc_DownloadURLPattern(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, ".tar.gz") && !strings.Contains(content, ".zip") {
		t.Error("doc must reference .tar.gz (linux/mac) or .zip (windows) archive files")
	}
	hasTarball := strings.Contains(content, "cheasee-pi_${VERSION}_${OS}_${ARCH}.tar.gz")
	hasZip := strings.Contains(content, "cheasee-pi_${VERSION}_${OS}_${ARCH}.zip") ||
		strings.Contains(content, "cheasee-pi_${VERSION}_windows_${ARCH}.zip") ||
		strings.Contains(content, "_windows_${ARCH}.zip")
	if !hasTarball && !hasZip {
		t.Error("doc curl URL must use GoReleaser naming pattern: cheasee-pi_${VERSION}_${OS}_${ARCH}.(tar.gz|zip)")
	}
}

// TestInstallationDoc_WindowsDownloadPath verifies the doc includes a
// Windows-specific download path (PowerShell snippet, .exe mention, or
// _windows_ archive URL reference).
func TestInstallationDoc_WindowsDownloadPath(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	// Check for at least one Windows-specific signal
	hasWindowsSignal := strings.Contains(content, "PowerShell") ||
		strings.Contains(content, ".exe") ||
		strings.Contains(content, "_windows_") ||
		strings.Contains(content, "Windows")
	if !hasWindowsSignal {
		t.Error("doc must reference Windows download path (PowerShell, .exe, or _windows_ archive)")
	}
}

// TestInstallationDoc_HasCheaseePiDown verifies Step 6 references
// 'cheasee-pi down' (exists in current binary) for stopping the container.
func TestInstallationDoc_HasCheaseePiDown(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "cheasee-pi down") {
		t.Error("installation.md should reference 'cheasee-pi down'")
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
