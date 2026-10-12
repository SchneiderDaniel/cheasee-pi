package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
// doc matches the path that config.go:fileRepository.repositoryConfigPath() actually
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
