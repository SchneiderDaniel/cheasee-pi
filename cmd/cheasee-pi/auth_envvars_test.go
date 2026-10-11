// This file exercises the auth envvars subcommand. The tests run the real
// cobra command and assert on its shell/JSON output — shell command
// execution here is intentional coverage of shell behavior (including the
// shell-format lines emitted for eval in a user's shell), not a credential
// leak; no real secrets are involved.
package main

import (
	"bytes"
	"encoding/json"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
	"regexp"
	"strings"
	"testing"
)

// linePattern matches "provider=ENV_VAR" lines
var linePattern = regexp.MustCompile(`^[a-z][a-z0-9-]*=[A-Z_]+$`)

// runAuthEnvvars calls the real runAuthEnvvarsE directly with the given format,
// captures stdout, and returns it. Avoids cobra global-state issues.
func runAuthEnvvars(t *testing.T, extraArgs ...string) string {
	t.Helper()

	// Check for --help: must go through cobra for help generation
	for _, a := range extraArgs {
		if a == "--help" || a == "-h" {
			return runAuthEnvvarsCobra(t, extraArgs...)
		}
	}

	format := authEnvvarsFormatFromArgs(extraArgs...)

	authEnvvarsFormat = format
	var stdout bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&stdout)
	err := runAuthEnvvarsE(cmd, nil)
	if err != nil {
		t.Errorf("runAuthEnvvarsE(_, %q) = %v", format, err)
	}
	return stdout.String()
}

// runAuthEnvvarsErr returns the error from runAuthEnvvarsE, for negative tests.
func runAuthEnvvarsErr(t *testing.T, extraArgs ...string) error {
	t.Helper()
	format := authEnvvarsFormatFromArgs(extraArgs...)

	authEnvvarsFormat = format
	cmd := &cobra.Command{}
	return runAuthEnvvarsE(cmd, nil)
}

// authEnvvarsFormatFromArgs extracts the --format value (default "shell").
func authEnvvarsFormatFromArgs(extraArgs ...string) string {
	format := "shell"
	for i, a := range extraArgs {
		if a == "--format" && i+1 < len(extraArgs) {
			format = extraArgs[i+1]
		}
	}
	return format
}

// runAuthEnvvarsCobra runs through cobra for tests that need full command parsing.
func runAuthEnvvarsCobra(t *testing.T, extraArgs ...string) string {
	t.Helper()
	out, _ := testutil.RunCobra(t, rootCmd, append([]string{"auth", "envvars"}, extraArgs...)...)
	return out
}

// ──────────────────────────────────────────────
// Phase 1: Domain — ProviderToEnvVar
// ──────────────────────────────────────────────

func TestAuthEnvvars_exitsZero(t *testing.T) {
	err := runAuthEnvvarsErr(t)
	if err != nil {
		t.Fatalf("auth envvars returned error: %v", err)
	}
}

func TestAuthEnvvars_producesOutput(t *testing.T) {
	output := runAuthEnvvars(t)
	if output == "" {
		t.Error("auth envvars produced no output")
	}
}

func TestAuthEnvvars_containsAllAliases(t *testing.T) {
	aliases := ProviderEnvAliases()
	output := runAuthEnvvars(t)

	for provider := range aliases {
		if !strings.Contains(output, provider+"=") {
			t.Errorf("auth envvars output missing provider %q", provider)
		}
	}
}

func TestAuthEnvvars_linesMatchPattern(t *testing.T) {
	output := runAuthEnvvars(t)
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}
		if !linePattern.MatchString(line) {
			t.Errorf("auth envvars line does not match pattern %q: %q", linePattern.String(), line)
		}
	}
}

func TestAuthEnvvars_formatJSON(t *testing.T) {
	aliases := ProviderEnvAliases()
	output := runAuthEnvvars(t, "--format", "json")

	var result map[string]string
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("auth envvars --format json is not valid JSON: %v\noutput: %s", err, output)
	}

	for provider, envVar := range aliases {
		got, ok := result[provider]
		if !ok {
			t.Errorf("auth envvars --format json missing provider %q", provider)
			continue
		}
		if got != envVar {
			t.Errorf("auth envvars --format json[%q] = %q, want %q", provider, got, envVar)
		}
	}
}

func TestAuthEnvvars_formatJSON_sameEntriesAsShell(t *testing.T) {
	shellOutput := runAuthEnvvars(t)
	jsonOutput := runAuthEnvvars(t, "--format", "json")

	shellLines := strings.Split(strings.TrimSpace(shellOutput), "\n")

	var jsonResult map[string]string
	if err := json.Unmarshal([]byte(jsonOutput), &jsonResult); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}

	if len(shellLines) != len(jsonResult) {
		t.Errorf("shell format has %d lines, JSON has %d entries", len(shellLines), len(jsonResult))
	}

	for _, line := range shellLines {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			t.Errorf("invalid shell line: %q", line)
			continue
		}
		jsonVal, ok := jsonResult[parts[0]]
		if !ok {
			t.Errorf("provider %q in shell but missing from JSON", parts[0])
			continue
		}
		if jsonVal != parts[1] {
			t.Errorf("provider %q: shell=%q, json=%q", parts[0], parts[1], jsonVal)
		}
	}
}

func TestAuthEnvvars_outputSorted(t *testing.T) {
	output := runAuthEnvvars(t)
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for i := 1; i < len(lines); i++ {
		if lines[i] == "" {
			continue
		}
		prev := strings.SplitN(lines[i-1], "=", 2)[0]
		curr := strings.SplitN(lines[i], "=", 2)[0]
		if prev > curr {
			t.Errorf("output not sorted: %q > %q at line %d", prev, curr, i)
		}
	}
}

func TestAuthEnvvars_noSecretValues(t *testing.T) {
	output := runAuthEnvvars(t)
	for _, suspicious := range FakeKeyPrefixes {
		if strings.Contains(output, suspicious) {
			t.Errorf("auth envvars output contains potential secret value %q", suspicious)
		}
	}
}

func TestAuthEnvvars_helpShowsFormatFlag(t *testing.T) {
	output := runAuthEnvvars(t, "--help")
	if !strings.Contains(output, "--format") {
		t.Errorf("auth envvars --help should mention --format flag\n--- output:\n%s", output)
	}
}

func TestAuthEnvvars_unknownFormatExitsNonZero(t *testing.T) {
	err := runAuthEnvvarsErr(t, "--format", "yaml")
	if err == nil {
		t.Fatal("auth envvars --format yaml should return error, got nil")
	}
}

func TestAuthEnvvars_worksWithoutAuthFile(t *testing.T) {
	output := runAuthEnvvars(t)
	if output == "" {
		t.Error("auth envvars produced no output even without auth file")
	}
}

// ──────────────────────────────────────────────
// Phase 4: Adapter — round-trip shell derivation
// ──────────────────────────────────────────────
