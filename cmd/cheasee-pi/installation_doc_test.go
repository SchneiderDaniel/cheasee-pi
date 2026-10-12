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

// TestInstallationDoc_OneLineInstaller verifies the install flow is the
// version-agnostic one-liner — the doc must NOT hardcode a version (a pinned
// VERSION="x.y.z" in docs goes stale and silently installs an old release;
// the one-liner always fetches latest).

func TestInstallationDoc_OneLineInstaller(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "scripts/install.sh") {
		t.Error("docs/installation.md should document the scripts/install.sh one-liner as the canonical install path")
	}
	if strings.Contains(content, `VERSION="`) {
		t.Error("docs/installation.md must not hardcode VERSION=\"…\" — the one-liner installs the latest release; a pinned version goes stale")
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

// installScriptPath is the path to scripts/install.sh relative to this
// package dir (tests run from cmd/cheasee-pi/).

func installScriptPath() string {
	return filepath.Join("..", "..", "scripts", "install.sh")
}

// TestInstallScript_DownloadURLPattern verifies the installer downloads
// GoReleaser archives using the naming pattern for every supported platform
// (linux/darwin .tar.gz, windows .zip).

func TestInstallScript_DownloadURLPattern(t *testing.T) {
	script := installScriptPath()
	data, err := os.ReadFile(script)
	if err != nil {
		t.Fatalf("reading scripts/install.sh: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "cheasee-pi_${VERSION}_${OS}_${ARCH}") {
		t.Error("install.sh must build the GoReleaser asset name: cheasee-pi_${VERSION}_${OS}_${ARCH}.${SUFFIX}")
	}
	if !strings.Contains(content, "tar.gz") || !strings.Contains(content, "zip") {
		t.Error("install.sh must map linux/darwin → SUFFIX=tar.gz and windows → SUFFIX=zip")
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
