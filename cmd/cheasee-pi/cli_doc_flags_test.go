package main

import (
	"github.com/spf13/pflag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCLIDoc_AllInitFlags(t *testing.T) {
	content := readCliDoc(t)
	initCmd.Flags().VisitAll(func(f *pflag.Flag) {
		if !strings.Contains(content, "--"+f.Name) {
			t.Errorf("docs/cli.md should document init flag --%s", f.Name)
		}
	})
}

// TestCLIDoc_SkillRepoFlagRow verifies the --skill-repo flag row mirrors the
// flag-help wording ("Custom skills …") — the doc half of the terminology
// contract; no doc↔CLI parity harness exists, so this string guard is the
// only check on the doc side. The "skill repos" rows elsewhere are untouched.

func TestCLIDoc_SkillRepoFlagRow(t *testing.T) {
	// Collapse whitespace so Prettier's markdown-table column padding does not
	// break the row guard — the cell wording, not the padding, is the contract.
	content := strings.Join(strings.Fields(readCliDoc(t)), " ")
	row := "| `--skill-repo <spec>` | Custom skills installed into the container (repeatable) |"
	if !strings.Contains(content, row) {
		t.Errorf("docs/cli.md --skill-repo row must be %q", row)
	}
	for _, gone := range []string{"custom skill/extension", "Skill/extension"} {
		if strings.Contains(content, gone) {
			t.Errorf("docs/cli.md must not contain %q (one consistent term)', got: %s", gone, content)
		}
	}
	for _, keep := range []string{"records custom skill repos", "skill repos"} {
		if !strings.Contains(content, keep) {
			t.Errorf("docs/cli.md 'skill repos' rows must stay (kept delivery-source wording), missing %q", keep)
		}
	}
}

// TestCLIDoc_StartAndAuthFlags verifies the auth subcommands and start flags
// are documented.

func TestCLIDoc_StartAndAuthFlags(t *testing.T) {
	content := readCliDoc(t)
	for _, sub := range []string{"auth add", "auth remove", "auth list", "auth envvars"} {
		if !strings.Contains(content, sub) {
			t.Errorf("docs/cli.md should document `cheasee-pi %s`", sub)
		}
	}
	for _, flag := range []string{"--build", "--api-key", "--no-docker-check", "--dry-run", "--name", "--workdir"} {
		if !strings.Contains(content, flag) {
			t.Errorf("docs/cli.md should document start flag %s", flag)
		}
	}
}

// ──────────────────────────────────────────────
// Phase 3: Checks / behavioral claims
// ──────────────────────────────────────────────

func TestCLIDoc_AtAGlanceBlastRadius(t *testing.T) {
	content := readCliDoc(t)
	for _, tc := range destructiveShorts {
		if !strings.Contains(content, tc.short) {
			t.Errorf("docs/cli.md should mirror %s's blast-radius Short %q", tc.name, tc.short)
		}
	}
}

// TestCLIDoc_LinksToDepth verifies the one-directional links: cli.md links
// to installation.md and daily-usage.md, and both link back to cli.md.

func TestCLIDoc_LinksToDepth(t *testing.T) {
	content := readCliDoc(t)
	for _, link := range []string{"installation.md", "daily-usage.md"} {
		if !strings.Contains(content, link) {
			t.Errorf("docs/cli.md should link to %s", link)
		}
	}
	readDoc := func(path string) string {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("reading %s: %v", path, err)
		}
		return string(data)
	}
	for _, path := range []string{
		filepath.Join("..", "..", "docs", "installation.md"),
		filepath.Join("..", "..", "docs", "daily-usage.md"),
	} {
		if !strings.Contains(readDoc(path), "cli.md") {
			t.Errorf("%s should link to cli.md", filepath.Base(path))
		}
	}
}

// TestCLIDoc_NoTutorialDuplication verifies cli.md stays a reference page:
// no install one-liner (curl / VERSION= snippet) and no troubleshooting
// section — those live in installation.md / daily-usage.md.

func TestCLIDoc_NoTutorialDuplication(t *testing.T) {
	content := readCliDoc(t)
	for _, banned := range []string{"curl", "VERSION=", "Troubleshooting"} {
		if strings.Contains(content, banned) {
			t.Errorf("docs/cli.md must not contain %q (tutorial detail belongs in installation.md / daily-usage.md)", banned)
		}
	}
}

// ──────────────────────────────────────────────
// Phase 5: UI control-center docs guards
// ──────────────────────────────────────────────
