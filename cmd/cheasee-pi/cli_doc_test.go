package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// cliDocPath is the path to the CLI reference doc relative to this test file.
func cliDocPath() string {
	// Test runs from the package directory (cmd/cheasee-pi/).
	return filepath.Join("..", "..", "docs", "cli.md")
}

func readCliDoc(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(cliDocPath())
	if err != nil {
		t.Fatalf("reading docs/cli.md: %v", err)
	}
	return string(data)
}

// readNavOrder extracts the nav_order value from a doc's Jekyll frontmatter.

func readNavOrder(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	inFront := false
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "---" {
			if inFront {
				break
			}
			inFront = true
			continue
		}
		if inFront && strings.HasPrefix(trimmed, "nav_order:") {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, "nav_order:"))
		}
	}
	return ""
}

// ──────────────────────────────────────────────
// Phase 1: Page shell & nav
// ──────────────────────────────────────────────

// TestCLIDoc_ExistsAndFrontmatter verifies docs/cli.md exists with the
// just-the-docs frontmatter contract (layout, title, unique fractional
// nav_order slotting between installation=2 and daily-usage=3).

func TestCLIDoc_ExistsAndFrontmatter(t *testing.T) {
	content := readCliDoc(t)
	if !strings.Contains(content, "layout: default") {
		t.Error("docs/cli.md must declare layout: default in frontmatter")
	}
	if !strings.Contains(content, "title: CLI Reference") {
		t.Error("docs/cli.md must declare title: CLI Reference in frontmatter")
	}
	if readNavOrder(t, cliDocPath()) != "2.5" {
		t.Error("docs/cli.md must declare nav_order: 2.5 in frontmatter")
	}
}

// TestCLIDoc_NavOrderUnique verifies every docs/*.md has a distinct nav_order,
// cli.md uses 2.5, and the pre-existing 1–11 values are unchanged (no
// renumbering — the page slots into the flat nav without touching siblings).

func TestCLIDoc_NavOrderUnique(t *testing.T) {
	entries, err := os.ReadDir(filepath.Join("..", "..", "docs"))
	if err != nil {
		t.Fatalf("listing docs/: %v", err)
	}

	existing := map[string]string{
		"index.md":            "1",
		"installation.md":     "2",
		"daily-usage.md":      "3",
		"architecture.md":     "4",
		"skills.md":           "5",
		"prompts.md":          "6",
		"extensions.md":       "7",
		"github.md":           "8",
		"security.md":         "9",
		"sbom.md":             "10",
		"acknowledgements.md": "11",
	}

	seen := make(map[string]string)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		path := filepath.Join("..", "..", "docs", e.Name())
		order := readNavOrder(t, path)
		if order == "" {
			continue // README.md (included via index.md) has no nav_order
		}
		if want, ok := existing[e.Name()]; ok && order != want {
			t.Errorf("docs/%s nav_order changed from %q to %q — renumbering is not allowed", e.Name(), want, order)
		}
		if prev, dup := seen[order]; dup {
			t.Errorf("nav_order collision: docs/%s and docs/%s both use %q", prev, e.Name(), order)
		}
		seen[order] = e.Name()
	}
	if seen["2.5"] != "cli.md" {
		t.Errorf("nav_order 2.5 must belong to cli.md, got %q", seen["2.5"])
	}
}

// ──────────────────────────────────────────────
// Phase 2: Command surface sync
// ──────────────────────────────────────────────

// TestCLIDoc_AllTopLevelCommands verifies every top-level command registered
// on rootCmd (excluding Cobra built-ins) is documented in cli.md.

func TestCLIDoc_AllTopLevelCommands(t *testing.T) {
	content := readCliDoc(t)
	for _, c := range rootCmd.Commands() {
		if builtInCmds[c.Name()] {
			continue
		}
		if !strings.Contains(content, c.Name()) {
			t.Errorf("docs/cli.md should document top-level command %q", c.Name())
		}
	}
}

// TestCLIDoc_AliasesDocumented verifies the documented aliases: no-args
// invocation = start, start alias up, down alias stop.

func TestCLIDoc_AliasesDocumented(t *testing.T) {
	content := readCliDoc(t)
	if !strings.Contains(content, "(no args)") {
		t.Error("docs/cli.md should state that `cheasee-pi` with no args runs start")
	}
	if !strings.Contains(content, "`up`") {
		t.Error("docs/cli.md should document the `up` alias for start")
	}
	if !strings.Contains(content, "`stop`") {
		t.Error("docs/cli.md should document the `stop` alias for down")
	}
}

// TestCLIDoc_AllInitFlags verifies every registered init flag appears in
// cli.md with its one-line meaning (mandated 8 + code-truth --reauth and
// --skill-repo).
