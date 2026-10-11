package main

import (
	"bytes"
	"errors"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
	"io"
	"strings"
	"testing"
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
