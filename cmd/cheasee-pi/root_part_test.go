package main

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestRootCmd_HelpNoAdditionalCommands(t *testing.T) {
	output := execRootHelp(t)
	for _, ghost := range []string{"Available Commands:", "Additional Commands:"} {
		if strings.Contains(output, ghost) {
			t.Errorf("grouped help must not render %q, got:\n%s", ghost, output)
		}
	}
}

func TestRootCmd_HelpContainsDocsLink(t *testing.T) {
	output := execRootHelp(t)
	if !strings.Contains(output, docsDailyUsageURL) {
		t.Errorf("help output must link the daily-usage docs (%s), got:\n%s", docsDailyUsageURL, output)
	}
}

func TestRootCmd_LongUsesCanonicalStart(t *testing.T) {
	if !strings.Contains(rootCmd.Long, "cheasee-pi start") {
		t.Error("rootCmd.Long must name the canonical 'cheasee-pi start' (not the stale 'up' alias)")
	}
	if strings.Contains(rootCmd.Long, "same as 'up'") {
		t.Error("rootCmd.Long must not reference the stale 'up' alias, which is not in the command list")
	}
	if !strings.Contains(rootCmd.Long, "Without a subcommand") {
		t.Error("rootCmd.Long must explain the no-arg auto-mode in a 'Without a subcommand' sentence")
	}
	// The no-arg explanation must cover all three folder states.
	for _, phrase := range []string{"empty", "cheasee-settings.json", "error"} {
		if !strings.Contains(rootCmd.Long, phrase) {
			t.Errorf("rootCmd.Long must cover the %q folder state in its no-arg explanation", phrase)
		}
	}
}

func TestRootCmd_HelpFirstTimeUserJourney(t *testing.T) {
	// Persona smoke: a first-time user with only `cheasee-pi --help` must be
	// able to answer (1) what the tool does, (2) how to start, (3) the daily
	// loop, (4) where the docs are — all from this single render.
	output := execRootHelp(t)
	for _, want := range []string{
		"pi coding agent",
		"Docker",
		"Getting started",
		"Daily use",
		"init",
		"start",
		"auth",
		"clean",
		"down",
		docsDailyUsageURL,
	} {
		if !strings.Contains(output, want) {
			t.Errorf("help output must mention %q for a first-time user, got:\n%s", want, output)
		}
	}
}

func TestRootCmd_NoRaspberryPiReference(t *testing.T) {
	if strings.Contains(rootCmd.Short, "Raspberry") {
		t.Error("rootCmd.Short must not reference Raspberry Pi")
	}
	if strings.Contains(rootCmd.Long, "Raspberry") {
		t.Error("rootCmd.Long must not reference Raspberry Pi")
	}
}

func TestRootCmd_UnknownFlagError(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "--unknown-flag")
	if err == nil {
		t.Error("expected error for unknown flag, got nil")
	}
	// SilenceUsage also suppresses the usage dump on flag/arg parse errors;
	// the error line itself remains the only guidance.
	if strings.Contains(output, "Usage:") || strings.Contains(output, "Available Commands:") {
		t.Errorf("flag errors must not dump the usage block, got:\n%s", output)
	}
}

func TestInitCmd_RunE(t *testing.T) {
	if initCmd.RunE == nil {
		t.Error("initCmd.RunE must be non-nil (use RunE, not Run)")
	}
}

func TestInitCmd_DisableAutoGenTag(t *testing.T) {
	if !initCmd.DisableAutoGenTag {
		t.Error("initCmd.DisableAutoGenTag should be true")
	}
}

func TestRootCmd_DisableAutoGenTag(t *testing.T) {
	if !rootCmd.DisableAutoGenTag {
		t.Error("rootCmd.DisableAutoGenTag should be true")
	}
}

func TestRootCmd_PersistentPreRunENil(t *testing.T) {
	if rootCmd.PersistentPreRunE != nil {
		t.Error("rootCmd.PersistentPreRunE must be nil (no hidden pre-run hooks)")
	}
}

func TestAllCommandsUseRunE(t *testing.T) {
	var check func(cmd *cobra.Command)
	check = func(cmd *cobra.Command) {
		t.Helper()
		if builtInCmds[cmd.Name()] {
			return
		}
		if cmd.RunE == nil && cmd.Run != nil {
			t.Errorf("command %q uses Run instead of RunE", cmd.Name())
		}
		for _, sub := range cmd.Commands() {
			check(sub)
		}
	}
	check(rootCmd)
}

func TestRootCmd_Version_IsNotStalePlaceholder(t *testing.T) {
	if rootCmd.Version == "0.1.0" {
		t.Errorf("rootCmd.Version is still the stale placeholder 0.1.0; update to %q", "1.0.0")
	}
}

func TestRootCmd_Version_NoVPrefix(t *testing.T) {
	if strings.HasPrefix(rootCmd.Version, "v") {
		t.Error("rootCmd.Version must not have a 'v' prefix (GoReleaser adds it in the tag, archive naming uses bare version)")
	}
}
