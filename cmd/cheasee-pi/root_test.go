package main

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// builtInCmds are Cobra-internal commands (help, completion) that are exempt
// from the RunE requirement since they are registered by Cobra itself.
var builtInCmds = map[string]bool{
	"help":       true,
	"completion": true,
}

func TestRootCmd_Use(t *testing.T) {
	if rootCmd.Use == "" {
		t.Error("rootCmd.Use must be non-empty")
	}
	if rootCmd.Short == "" {
		t.Error("rootCmd.Short must be non-empty")
	}
	if rootCmd.Long == "" {
		t.Error("rootCmd.Long must be non-empty")
	}
}

func TestRootCmd_HasInitSubcommand(t *testing.T) {
	found := false
	for _, c := range rootCmd.Commands() {
		if c.Name() == "init" {
			found = true
			break
		}
	}
	if !found {
		t.Error("rootCmd must have 'init' registered as a subcommand")
	}
}

func TestRootCmd_HelpContainsAppName(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "--help")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(output, rootCmd.Use) {
		t.Errorf("help output should contain app name %q", rootCmd.Use)
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
	_, err := testutil.RunCobra(t, rootCmd, "--unknown-flag")
	if err == nil {
		t.Error("expected error for unknown flag, got nil")
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

func TestRootCmd_Version_IsValidSemver(t *testing.T) {
	v := rootCmd.Version
	if v == "" {
		t.Fatal("rootCmd.Version must not be empty")
	}
	// Semver validation: must match MAJOR.MINOR[.PATCH]
	parts := strings.Split(v, ".")
	if len(parts) < 2 || len(parts) > 3 {
		t.Errorf("rootCmd.Version %q is not valid semver (expected MAJOR.MINOR[.PATCH])", v)
	}
	for _, p := range parts {
		if p == "" {
			t.Errorf("rootCmd.Version %q has empty segment", v)
		}
		for _, c := range p {
			if c < '0' || c > '9' {
				t.Errorf("rootCmd.Version %q contains non-numeric segment %q", v, p)
			}
		}
	}
}

func TestRootCmd_Version_IsExpectedRelease(t *testing.T) {
	expected := "0.54"
	if rootCmd.Version != expected {
		t.Errorf("rootCmd.Version = %q, want %q", rootCmd.Version, expected)
	}
}

func TestInitCmd_HelpShowsFlags(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "init", "--help")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(output, "--api-key") {
		t.Errorf("init --help output should show --api-key flag\n--- output:\n%s", output)
	}
	if !strings.Contains(output, "--no-docker-check") {
		t.Errorf("init --help output should show --no-docker-check flag\n--- output:\n%s", output)
	}
}
