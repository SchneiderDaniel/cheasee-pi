package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// legacyAmbiguousClonePhrase is the pre-fix sentence behind the "which repo?"
// confusion the issue reports: it never stated the cloned repo is cheasee-pi's
// own. No user-facing text (help, docs) may (re)state it.
const legacyAmbiguousClonePhrase = "clones the cheasee-pi repo at build time"

// readRepoDoc reads a top-level docs/*.md from the package dir
// (cmd/cheasee-pi/), mirroring cliDocPath in cli_doc_test.go.
func readRepoDoc(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", name))
	if err != nil {
		t.Fatalf("reading docs/%s: %v", name, err)
	}
	return string(data)
}

// ──────────────────────────────────────────────
// start --help: build-time clone disambiguation
// ──────────────────────────────────────────────

func TestUpHelp_LongDisambiguatesOwnRepo(t *testing.T) {
	long := upCmd.Long
	for _, want := range []string{"own repository", "not your repo"} {
		if !strings.Contains(long, want) {
			t.Errorf("start Long must state %q (the cloned repo is cheasee-pi's own), got: %q", want, long)
		}
	}
	if strings.Contains(long, legacyAmbiguousClonePhrase) {
		t.Errorf("start Long must not resurface the legacy ambiguous sentence %q, got: %q", legacyAmbiguousClonePhrase, long)
	}
}

func TestUpHelp_RenderedHelpDisambiguates(t *testing.T) {
	// Guard the rendered help surface, not just the struct field.
	out, err := testutil.RunCobra(t, rootCmd, "start", "--help")
	if err != nil {
		t.Fatalf("start --help: %v", err)
	}
	if !strings.Contains(out, "own repository") {
		t.Errorf("rendered start --help must say 'own repository', got: %q", out)
	}
	if !strings.Contains(out, "not your repo") {
		t.Errorf("rendered start --help must say 'not your repo', got: %q", out)
	}
}

// ──────────────────────────────────────────────
// Docs sweep: same-sentence drift guard
// ──────────────────────────────────────────────

func TestDocs_CloneWordingSweep(t *testing.T) {
	// installation.md is the first-read location for a new user — the sweep
	// must reach every doc mirror or the "which repo?" confusion persists.
	for _, name := range []string{"installation.md", "architecture.md", "daily-usage.md"} {
		content := readRepoDoc(t, name)
		if !strings.Contains(content, "own repository") {
			t.Errorf("docs/%s must state the build-time clone is cheasee-pi's OWN repository", name)
		}
		if strings.Contains(content, legacyAmbiguousClonePhrase) {
			t.Errorf("docs/%s must not contain the legacy ambiguous phrase %q", name, legacyAmbiguousClonePhrase)
		}
	}
}

func TestDocs_FirstBuildClaimLoadIndependent(t *testing.T) {
	// Fixed-minute first-build claims ("~2 min") mislead on slow links (the
	// ~646MB chromium fetch alone is ~4.5 min at 20 Mbps) — the docs must be
	// load-independent like the runtime notice.
	for _, name := range []string{"installation.md", "daily-usage.md"} {
		content := readRepoDoc(t, name)
		if strings.Contains(content, "~2 min") {
			t.Errorf("docs/%s must not promise a fixed '~2 min' first build", name)
		}
	}
}
