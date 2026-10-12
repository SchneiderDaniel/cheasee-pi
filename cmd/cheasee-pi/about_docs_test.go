package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCLIDoc_aboutDocumented(t *testing.T) {
	content := readCliDoc(t)
	if !strings.Contains(content, "cheasee-pi about") {
		t.Error("docs/cli.md must document `cheasee-pi about` (TestCLIDoc_AllTopLevelCommands gate)")
	}
	if !strings.Contains(content, "`intro`") {
		t.Error("docs/cli.md must document the `intro` alias")
	}
}

func TestDailyUsageDoc_aboutGlossaryTrailer(t *testing.T) {
	// Every key term the about const asserts must exist somewhere in the docs
	// corpus, so the binary copy cannot drift beyond what the docs define.
	data := ""
	for _, path := range []string{"daily-usage.md", "cli.md", "installation.md"} {
		b, err := os.ReadFile(filepath.Join("..", "..", "docs", path))
		if err != nil {
			t.Fatalf("reading docs/%s: %v", path, err)
		}
		data += string(b)
	}
	for _, term := range []string{
		"cheasee-settings.json",          // workspace marker
		"~/.config/cheasee-pi/auth.json", // provider key location
		"8470",                           // CodeFlow port base
		"CHEASEE_REF",                    // build ARG
		"pi install",                     // skill repo install mechanism
	} {
		if !strings.Contains(data, term) {
			t.Errorf("docs corpus must define glossary term %q", term)
		}
	}
	if docsDailyUsageURL != "https://schneiderdaniel.github.io/cheasee-pi/daily-usage" {
		t.Errorf("docsDailyUsageURL = %q, want the published daily-usage URL", docsDailyUsageURL)
	}
}

// TestAbout_singleSourceStatic mirrors TestCodeFlowHint_singleSourceStatic:
// the glossary body must live only in about.go/about_test.go — no other
// top-level command source may re-print the glossary lines. (The published
// URL is excluded: root.go owns it as docsDailyUsageURL and about reuses it.)

func TestAbout_singleSourceStatic(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("list package dir: %v", err)
	}
	markers := []string{"one workspace per repo", "cheasee-settings.json marks it"}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasPrefix(name, "about") {
			continue
		}
		data, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, m := range markers {
			if strings.Contains(string(data), m) {
				t.Errorf("%s must not re-print the about glossary (marker %q) — keep it in about.go", name, m)
			}
		}
	}
}

// TestAbout_writeErrorPropagates: a broken stdout writer must fail the
// command with the wrapped write error — never a silent partial success.
