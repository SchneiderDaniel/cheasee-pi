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

// TestInstallationDoc_OneShotFirstRun verifies the empty-folder gate bullet
// describes the single-invocation flow (init + start in one run) — the
// two-step "run start again" handoff is gone.
func TestInstallationDoc_OneShotFirstRun(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	if strings.Contains(content, "then you run `start` again") {
		t.Error("installation.md must not describe a two-step first run (run start again)")
	}
	if !strings.Contains(content, "same invocation") {
		t.Error("installation.md should describe the one-shot continuation (init + start in the same invocation)")
	}
}

// TestInstallationDoc_SkillRepoStep verifies the init step list documents the
// custom skill-repo phase and its non-interactive --skill-repo flag.
func TestInstallationDoc_SkillRepoStep(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "custom skill") && !strings.Contains(content, "skill repositor") {
		t.Error("installation.md should document the custom skill-repo init step")
	}
	if !strings.Contains(content, "--skill-repo") {
		t.Error("installation.md should document the --skill-repo flag")
	}
	if !strings.Contains(content, "pi update") {
		t.Error("installation.md should mention the pi update reconciliation benefit")
	}
}

// TestDailyUsageDoc_OneShotFirstRun verifies daily-usage.md describes the
// single-invocation auto-init continuation instead of a two-step handoff.
func TestDailyUsageDoc_OneShotFirstRun(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "daily-usage.md"))
	if err != nil {
		t.Fatalf("reading docs/daily-usage.md: %v", err)
	}
	content := string(data)

	if strings.Contains(content, "auto-inits first.") {
		t.Error("daily-usage.md must not describe auto-init as a standalone step (no continuation)")
	}
	if !strings.Contains(content, "same invocation") {
		t.Error("daily-usage.md should describe the single-invocation auto-init continuation")
	}
}

// TestInstallationDoc_UninstallScriptReference verifies the Uninstall section
// presents the standalone scripts/uninstall.sh one-liner as the primary path
// (issue #1510) while retaining the `cheasee-pi uninstall` subcommand for
// workspace-level cleanup — and drops the misleading `sudo` prefix (under
// sudo, os.UserCacheDir/UserConfigDir resolve to /root).
func TestInstallationDoc_UninstallScriptReference(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "scripts/uninstall.sh") {
		t.Error("Uninstall section should reference scripts/uninstall.sh")
	}
	if !strings.Contains(content, "curl -fsL") {
		t.Error("Uninstall section should show the curl one-liner (curl -fsL ... | bash)")
	}
	if !strings.Contains(content, "--force") {
		t.Error("Uninstall section should document the --force flag")
	}
	if !strings.Contains(content, "cheasee-pi uninstall") {
		t.Error("Uninstall section should retain 'cheasee-pi uninstall' for workspace-level cleanup")
	}
	if strings.Contains(content, "sudo cheasee-pi uninstall") {
		t.Error("Uninstall section must not present 'sudo cheasee-pi uninstall' as the primary path (sudo resets HOME, deleting root's state)")
	}
	if !strings.Contains(content, "cheasee-pi/auth.json") {
		t.Error("Uninstall section should retain the cheasee-pi/auth.json XDG path reference")
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
		!strings.Contains(content, "cheasee-pi"+string(os.PathSeparator)+"auth.json") {
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
