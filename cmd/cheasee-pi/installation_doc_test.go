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
