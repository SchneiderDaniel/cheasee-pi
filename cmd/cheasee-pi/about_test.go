package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// 'cheasee-pi about' (alias 'intro'): non-interactive glossary print.
// Pure-print command with no flags, no args validation, no stderr output —
// the happy-path contract IS the user journey.
//
// Invocation note: cobra's ExecuteC runs on the root only, so subcommands are
// executed via the repo convention `RunCobra(t, rootCmd, "about", ...)` (the
// same full-root resolution every init/auth test uses). Executing aboutCmd
// directly with no args would delegate to rootCmd's os.Args fallback.
// ──────────────────────────────────────────────

func TestAbout_outputContract(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "about")
	if err != nil {
		t.Fatalf("about must succeed with no args: %v", err)
	}
	if strings.TrimSpace(output) == "" {
		t.Fatal("about must print a non-empty glossary to stdout")
	}
}

func TestAbout_writesToCmdOut(t *testing.T) {
	// runAboutE must write via cmd.OutOrStdout() (so the test runner captures
	// it) — a direct os.Stdout write would escape the buffer and fail here.
	cmd := &cobra.Command{Use: "about"}
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(io.Discard)
	if err := runAboutE(cmd, nil); err != nil {
		t.Fatalf("runAboutE: %v", err)
	}
	if strings.TrimSpace(out.String()) == "" {
		t.Error("runAboutE must write the glossary to cmd.OutOrStdout(), got empty buffer")
	}
}

func TestAbout_contentContract(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "about")
	if err != nil {
		t.Fatalf("about: %v", err)
	}
	checks := []struct{ want, msg string }{
		{"one workspace per repo", "what cheasee-pi is"},
		{"workflow", "one-sentence workflow line"},
		{"cheasee-pi init", "workflow starts at init"},
		{"auth add <provider>", "workflow includes provider authentication"},
		{"cheasee-pi start", "workflow ends at start"},
		{"cheasee-settings.json", "workspace marker"},
		{"bare clone", "bare repo definition"},
		{"worktree", "worktree definition"},
		{"Docker image", "container/image definition"},
		{"Docker is required", "why Docker is required"},
		{"isolate", "Docker rationale: isolates the pi runtime"},
		{"mount the repo", "Docker rationale: mounts the repo into the container"},
		{"LLM vendor", "provider = LLM vendor"},
		{"~/.config/cheasee-pi/auth.json", "provider key location"},
		{"injected as env vars", "provider key injection"},
		{"pi install -l", "skill repos installed via pi install"},
		{".pi/settings.json", "project-level -l target of pi install"},
		{"optional browser sidecar", "CodeFlow = optional sidecar"},
		{"8470 + fnv32(repo-slug) % 1024", "CodeFlow port derivation"},
		{"CHEASEE_REF", "CHEASEE_REF build ARG"},
		{"default main", "CHEASEE_REF default"},
	}
	for _, c := range checks {
		if !strings.Contains(output, c.want) {
			t.Errorf("about output must contain %q (%s)\n--- output:\n%s", c.want, c.msg, output)
		}
	}
}

func TestAbout_linkContract(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "about")
	if err != nil {
		t.Fatalf("about: %v", err)
	}
	if !strings.Contains(output, "docs/daily-usage.md") {
		t.Errorf("about must link the repo-relative docs/daily-usage.md path\n--- output:\n%s", output)
	}
	if !strings.Contains(output, "pi.dev") {
		t.Errorf("about must link pi.dev\n--- output:\n%s", output)
	}
}

func TestAbout_brevityContract(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "about")
	if err != nil {
		t.Fatalf("about: %v", err)
	}
	count := 0
	for _, line := range strings.Split(output, "\n") {
		if strings.TrimSpace(line) != "" {
			count++
		}
	}
	if count < 8 || count > 20 {
		t.Errorf("about must print ~10 non-empty lines, got %d\n--- output:\n%s", count, output)
	}
}

func TestAbout_stdoutStderrSplit(t *testing.T) {
	// about writes via cmd.OutOrStdout() — no CodeFlow-style ℹ stderr
	// annotation may leak into its success path.
	stderr := testutil.CaptureStderr(t, func() {
		if _, err := testutil.RunCobra(t, rootCmd, "about"); err != nil {
			t.Fatalf("about: %v", err)
		}
	})
	if strings.TrimSpace(stderr) != "" {
		t.Errorf("about must keep stderr empty on success, got: %q", stderr)
	}
}

func TestAbout_extraArgsTolerated(t *testing.T) {
	// No Args validator: cobra default ArbitraryArgs — 'about some extra args'
	// exits 0 and still prints the glossary.
	output, err := testutil.RunCobra(t, rootCmd, "about", "some", "extra", "args")
	if err != nil {
		t.Fatalf("about with extra args must succeed: %v", err)
	}
	if !strings.Contains(output, "cheasee-settings.json") {
		t.Errorf("about with extra args must still print the glossary\n--- output:\n%s", output)
	}
}

func TestAbout_unknownFlagError(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "about", "--unknown-flag")
	if err == nil {
		t.Fatal("about --unknown-flag must return an error")
	}
	// Root SilenceUsage propagates: the error line is the only guidance.
	if !strings.Contains(err.Error(), "unknown flag") {
		t.Errorf("error must name the unknown flag, got: %v", err)
	}
	if strings.Contains(output, "Usage:") || strings.Contains(output, "Available Commands:") {
		t.Errorf("flag errors must not dump the usage block, got:\n%s", output)
	}
}

func TestAbout_helpContract(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "about", "--help")
	if err != nil {
		t.Fatalf("about --help must exit 0: %v", err)
	}
	if !strings.Contains(output, "Usage:") || !strings.Contains(output, "glossary of cheasee-pi's core concepts") {
		t.Errorf("about --help must show Usage: + the command description\n--- output:\n%s", output)
	}
	if strings.Contains(output, "cheasee-settings.json") {
		t.Errorf("about --help must not print the glossary body\n--- output:\n%s", output)
	}
	if strings.Contains(output, "Auto generated by spf13/cobra") {
		t.Errorf("about help must not carry the auto-gen tag (DisableAutoGenTag)\n--- output:\n%s", output)
	}
}

func TestAbout_registrationContract(t *testing.T) {
	found := false
	for _, c := range rootCmd.Commands() {
		if c.Name() == "about" {
			found = true
			if !containsStr(c.Aliases, "intro") {
				t.Error("aboutCmd.Aliases must contain 'intro'")
			}
			if c.RunE == nil {
				t.Error("aboutCmd.RunE must be non-nil (use RunE, not Run)")
			}
			break
		}
	}
	if !found {
		t.Fatal("rootCmd must have 'about' registered as a subcommand")
	}
}

func TestAbout_discoverableInRootHelp(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "--help")
	if err != nil {
		t.Fatalf("root --help: %v", err)
	}
	// about must be listed in root help (runnable ⇒ grouped listing under
	// "Getting started"; the grouped template has no "Available Commands:").
	if !strings.Contains(output, "Getting started") || !strings.Contains(output, "\n  about ") {
		t.Errorf("root help must list 'about' under its lifecycle group\n--- output:\n%s", output)
	}
}

// ──────────────────────────────────────────────
// Phase 2: alias identity + cobra help resolution
// ──────────────────────────────────────────────

func TestAbout_aliasByteIdentical(t *testing.T) {
	// Reset the shared help flag: a prior 'about --help' run leaves it set on
	// aboutCmd's FlagSet, which would short-circuit a plain run into a help
	// print (same reset executeRootRunError performs on rootCmd).
	_ = aboutCmd.Flags().Set("help", "false")
	base, err := testutil.RunCobra(t, rootCmd, "about")
	if err != nil {
		t.Fatalf("about: %v", err)
	}
	if !strings.Contains(base, "cheasee-settings.json") {
		t.Fatalf("about must run (not print help) — stale help flag?\n--- output:\n%s", base)
	}
	intro, err := testutil.RunCobra(t, rootCmd, "intro")
	if err != nil {
		t.Fatalf("cheasee-pi intro: %v", err)
	}
	if intro != base {
		t.Errorf("'intro' output must be byte-identical to 'about'\n--- about:\n%s\n--- intro:\n%s", base, intro)
	}
}

func TestRootHelpIntro_resolvesAlias(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "help", "intro")
	if err != nil {
		t.Fatalf("cheasee-pi help intro must resolve (cobra Find matches aliases): %v", err)
	}
	if !strings.Contains(output, "about") || !strings.Contains(output, "Usage:") {
		t.Errorf("help intro output must be about's help (contains 'about' + 'Usage:')\n--- output:\n%s", output)
	}
}

func TestAbout_helpFlagEqualsHelpCommand(t *testing.T) {
	flagHelp, err := testutil.RunCobra(t, rootCmd, "about", "--help")
	if err != nil {
		t.Fatalf("about --help: %v", err)
	}
	cmdHelp, err := testutil.RunCobra(t, rootCmd, "help", "about")
	if err != nil {
		t.Fatalf("help about: %v", err)
	}
	if flagHelp != cmdHelp {
		t.Errorf("'about --help' and 'help about' must both route through c.Help()\n--- --help:\n%s\n--- help about:\n%s", flagHelp, cmdHelp)
	}
}

// ──────────────────────────────────────────────
// Phase 3: doc sync + drift guards
// ──────────────────────────────────────────────

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
func TestAbout_writeErrorPropagates(t *testing.T) {
	cmd := &cobra.Command{Use: "about"}
	cmd.SetOut(failingWriter{})
	cmd.SetErr(io.Discard)
	err := runAboutE(cmd, nil)
	if err == nil {
		t.Fatal("runAboutE must return the writer error, not swallow it")
	}
	if !errors.Is(err, errBrokenWriter) {
		t.Errorf("runAboutE must wrap the underlying write error (errors.Is), got: %v", err)
	}
}

// errBrokenWriter + failingWriter simulate a closed pipe / broken stdout.
type failingWriter struct{}

var errBrokenWriter = errors.New("broken writer")

func (failingWriter) Write([]byte) (int, error) { return 0, errBrokenWriter }

func containsStr(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
