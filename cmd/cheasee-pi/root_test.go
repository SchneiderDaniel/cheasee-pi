package main

import (
	"bytes"
	"fmt"
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
	expected := "0.55.3"
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

// executeRootRunError drives the real rootCmd through cobra's ExecuteC on the
// docker-missing auto-init failure path (the issue's first-run scenario) with
// hermetic stdout/stderr buffers, returning both. Package tests are serialized
// (no t.Parallel), so mutating the package-global rootCmd is safe.
func executeRootRunError(t *testing.T) (string, string) {
	t.Helper()
	workdir := t.TempDir()
	setUpRunMode(t, workdir, false)
	stubLookPath(t, func(_ string) (string, error) { return "", fmt.Errorf("executable not found in $PATH") })

	// A prior RunCobra call (e.g. TestRootCmd_HelpContainsAppName's --help)
	// leaves the help flag value set on the shared rootCmd FlagSet — without a
	// reset the next ExecuteC short-circuits into a help print and returns nil.
	_ = rootCmd.Flags().Set("help", "false")
	var out, errOut bytes.Buffer
	rootCmd.SetOut(&out)
	rootCmd.SetErr(&errOut)
	// Explicit empty args keep ExecuteC off the os.Args fallback (under
	// `go test` that is the -test.* flags pflag silently swallows).
	rootCmd.SetArgs([]string{})
	_, err := rootCmd.ExecuteC()
	if err == nil {
		t.Fatal("expected a run error on the docker-missing auto-init path, got nil")
	}
	return out.String(), errOut.String()
}

func TestRootCmd_SilenceUsage_NoUsageOnRunError(t *testing.T) {
	t.Helper()
	out, _ := executeRootRunError(t)
	if strings.Contains(out, "Usage:") || strings.Contains(out, "Available Commands:") {
		t.Errorf("run errors must not dump the usage block, got:\n%s", out)
	}
}

func TestRootCmd_RunErrorPrintedOnce(t *testing.T) {
	// Guard against the double-print trap: SilenceErrors stays false and
	// main.go prints nothing, so cobra is the single "Error: " owner on stderr
	// — exactly one prefix carrying the docker-missing message.
	_, errOut := executeRootRunError(t)
	if got := strings.Count(errOut, "Error: "); got != 1 {
		t.Errorf("stderr must print the error exactly once, got %d 'Error: ' occurrences:\n%s", got, errOut)
	}
	if !strings.Contains(errOut, "Docker is not installed") {
		t.Errorf("stderr must carry the docker-missing message, got:\n%s", errOut)
	}
}
