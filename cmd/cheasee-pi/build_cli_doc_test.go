package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCLIDoc_BuildNoAlias(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "cli.md"))
	if err != nil {
		t.Fatalf("reading docs/cli.md: %v", err)
	}
	content := string(data)
	start := strings.Index(content, "## `cheasee-pi build` / `rebuild`")
	if start == -1 {
		t.Fatal("cli.md must have a '## `cheasee-pi build` / `rebuild`' section")
	}
	section := content[start:]

	if !strings.Contains(section, "rebuild") {
		t.Error("the build/rebuild section must point at `rebuild` as the no-cache path")
	}
	if strings.Contains(section, "--no-cache") {
		t.Error("the build/rebuild section must not list --no-cache (rebuild is the no-cache path)")
	}
	if strings.Contains(section, "compatibility alias") {
		t.Error("the build/rebuild section must not claim a compatibility alias")
	}
}

func TestDailyUsageDoc_PullClaim(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "daily-usage.md"))
	if err != nil {
		t.Fatalf("reading docs/daily-usage.md: %v", err)
	}
	content := string(data)
	start := strings.Index(content, "### Full rebuild")
	if start == -1 {
		t.Fatal("daily-usage.md must have a '### Full rebuild' section")
	}
	section := content[start:]

	// The base-image-security-use bullet must be served by rebuild's --pull,
	// not by --no-cache alone (--no-cache reuses the locally cached base
	// image; only --pull refreshes it).
	if !strings.Contains(section, "--pull") {
		t.Error("the Full rebuild section must document --pull (base-image refresh)")
	}
	if !strings.Contains(section, "security updates") {
		t.Error("the section must keep the base-image security-updates use case")
	}
}

func TestInstallationDoc_RebuildCommand(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "cheasee-pi rebuild") {
		t.Error("installation.md troubleshooting must list 'cheasee-pi rebuild' as the rebuild path")
	}
}

func TestZedTasks_RebuildCommand(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", ".zed", "tasks.json"))
	if err != nil {
		t.Fatalf("reading .zed/tasks.json: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, `"label": "Cheasee-Pi: rebuild (no cache)"`) {
		t.Error(".zed/tasks.json must keep the rebuild task label")
	}
	if !strings.Contains(content, `"command": "cheasee-pi rebuild"`) {
		t.Error(".zed/tasks.json rebuild task must run 'cheasee-pi rebuild'")
	}
	if strings.Contains(content, `"command": "cheasee-pi build --no-cache"`) {
		t.Error(".zed/tasks.json must not use the legacy 'cheasee-pi build --no-cache' command")
	}
}

func TestZedTasks_PruneImages(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", ".zed", "tasks.json"))
	if err != nil {
		t.Fatalf("reading .zed/tasks.json: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, `"label": "Cheasee-Pi: prune images (preview)"`) {
		t.Error(".zed/tasks.json must keep the prune-images preview task label")
	}
	if !strings.Contains(content, `"command": "cheasee-pi prune-images --dry-run"`) {
		t.Error(".zed/tasks.json preview task must run 'cheasee-pi prune-images --dry-run'")
	}
	if !strings.Contains(content, `"label": "Cheasee-Pi: prune images"`) {
		t.Error(".zed/tasks.json must keep the prune-images task label")
	}
	if !strings.Contains(content, `"command": "cheasee-pi prune-images"`) {
		t.Error(".zed/tasks.json prune-images task must run 'cheasee-pi prune-images'")
	}
}
