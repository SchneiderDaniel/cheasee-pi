package main

import (
	"bytes"
	"fmt"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

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
	expected := "0.67.0"
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
