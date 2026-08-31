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

// TestInstallationDoc_TwoStepFirstRun verifies the empty-folder gate bullet
// describes the two-step flow: init runs and STOPS (init never launches pi),
// and the user re-runs start to launch.
func TestInstallationDoc_TwoStepFirstRun(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	if strings.Contains(content, "same invocation") {
		t.Error("installation.md must not describe a one-shot continuation (init + start fused)")
	}
	if !strings.Contains(content, "run `cheasee-pi start` again") {
		t.Error("installation.md should describe the two-step handoff (run start again after init)")
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

// TestDailyUsageDoc_TwoStepFirstRun verifies daily-usage.md describes the
// two-step handoff: init auto-runs and stops, then the user re-runs start.
func TestDailyUsageDoc_TwoStepFirstRun(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "daily-usage.md"))
	if err != nil {
		t.Fatalf("reading docs/daily-usage.md: %v", err)
	}
	content := string(data)

	if strings.Contains(content, "auto-inits first.") {
		t.Error("daily-usage.md must not describe auto-init as a standalone step (no continuation)")
	}
	if strings.Contains(content, "same invocation") {
		t.Error("daily-usage.md must not describe a one-shot continuation")
	}
	if !strings.Contains(content, "run `cheasee-pi start` again") {
		t.Error("daily-usage.md should describe the two-step handoff (run start again after init)")
	}
}

// TestInstallationDoc_UninstallScriptReference verifies the Uninstall section
// presents the standalone scripts/uninstall.sh one-liner as the primary path
// (issue #1510) while retaining the `cheasee-pi uninstall` subcommand — and
// drops the misleading `sudo` prefix (under sudo, os.UserCacheDir/
// UserConfigDir resolve to /root).
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
