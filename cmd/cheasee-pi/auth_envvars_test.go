package main

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/spf13/cobra"
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

	format := "shell"
	for i, a := range extraArgs {
		if a == "--format" && i+1 < len(extraArgs) {
			format = extraArgs[i+1]
		}
	}

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
	format := "shell"
	for i, a := range extraArgs {
		if a == "--format" && i+1 < len(extraArgs) {
			format = extraArgs[i+1]
		}
	}

	authEnvvarsFormat = format
	cmd := &cobra.Command{}
	return runAuthEnvvarsE(cmd, nil)
}

// runAuthEnvvarsCobra runs through cobra for tests that need full command parsing.
func runAuthEnvvarsCobra(t *testing.T, extraArgs ...string) string {
	t.Helper()
	var stdout, stderr bytes.Buffer
	rootCmd.SetOut(&stdout)
	rootCmd.SetErr(&stderr)
	rootCmd.SetArgs(append([]string{"auth", "envvars"}, extraArgs...))
	rootCmd.ExecuteC() //nolint:errcheck
	return stdout.String()
}

// ──────────────────────────────────────────────
// Phase 1: Domain — ProviderToEnvVar
// ──────────────────────────────────────────────

func TestProviderToEnvVar_knownProviders(t *testing.T) {
	tests := []struct {
		provider string
		want     string
	}{
		{"opencode-go", "OPENCODE_API_KEY"},
		{"opencode", "OPENCODE_API_KEY"},
		{"openai", "OPENAI_API_KEY"},
		{"anthropic", "ANTHROPIC_API_KEY"},
		{"claude", "ANTHROPIC_API_KEY"},
		{"deepseek", "DEEPSEEK_API_KEY"},
		{"gemini", "GEMINI_API_KEY"},
		{"google", "GEMINI_API_KEY"},
		{"groq", "GROQ_API_KEY"},
		{"mistral", "MISTRAL_API_KEY"},
		{"openrouter", "OPENROUTER_API_KEY"},
		{"xai", "XAI_API_KEY"},
		{"fireworks", "FIREWORKS_API_KEY"},
		{"together", "TOGETHER_API_KEY"},
		{"cerebras", "CEREBRAS_API_KEY"},
	}
	for _, tt := range tests {
		got := ProviderToEnvVar(tt.provider)
		if got != tt.want {
			t.Errorf("ProviderToEnvVar(%q) = %q, want %q", tt.provider, got, tt.want)
		}
	}
}

func TestProviderToEnvVar_unknownProvider(t *testing.T) {
	if got := ProviderToEnvVar("unknown"); got != "" {
		t.Errorf("ProviderToEnvVar(%q) = %q, want empty", "unknown", got)
	}
}

func TestProviderToEnvVar_emptyString(t *testing.T) {
	if got := ProviderToEnvVar(""); got != "" {
		t.Errorf("ProviderToEnvVar(%q) = %q, want empty", "", got)
	}
}

// ──────────────────────────────────────────────
// Phase 1: Domain — ProviderEnvAliases
// ──────────────────────────────────────────────

func TestProviderEnvAliases_containsAllKnownProviders(t *testing.T) {
	aliases := ProviderEnvAliases()

	for _, name := range ProviderNames() {
		envVar, ok := aliases[name]
		if !ok {
			t.Errorf("ProviderEnvAliases missing known provider %q", name)
			continue
		}
		if envVar == "" {
			t.Errorf("ProviderEnvAliases[%q] is empty", name)
		}
	}
}

func TestProviderEnvAliases_includesDocumentedAliases(t *testing.T) {
	aliases := ProviderEnvAliases()

	aliasChecks := []struct {
		alias string
		want  string
	}{
		{"claude", "ANTHROPIC_API_KEY"},
		{"google", "GEMINI_API_KEY"},
		{"opencode", "OPENCODE_API_KEY"},
	}
	for _, ac := range aliasChecks {
		got, ok := aliases[ac.alias]
		if !ok {
			t.Errorf("ProviderEnvAliases missing documented alias %q", ac.alias)
			continue
		}
		if got != ac.want {
			t.Errorf("ProviderEnvAliases[%q] = %q, want %q", ac.alias, got, ac.want)
		}
	}
}

func TestProviderEnvAliases_includesDriftVictims(t *testing.T) {
	aliases := ProviderEnvAliases()

	driftVictims := []string{"xai", "fireworks", "together", "cerebras"}
	for _, p := range driftVictims {
		if _, ok := aliases[p]; !ok {
			t.Errorf("ProviderEnvAliases missing drift victim %q", p)
		}
	}
}

func TestProviderEnvAliases_allEntriesMapToNonEmpty(t *testing.T) {
	aliases := ProviderEnvAliases()
	for provider, envVar := range aliases {
		if envVar == "" {
			t.Errorf("ProviderEnvAliases[%q] is empty", provider)
		}
	}
}

func TestProviderEnvAliases_knownEntriesHaveDistinctEnvVars(t *testing.T) {
	aliases := ProviderEnvAliases()
	knownSet := make(map[string]bool)
	for _, name := range ProviderNames() {
		knownSet[name] = true
	}

	seen := make(map[string]string) // envVar → provider
	for provider, envVar := range aliases {
		if !knownSet[provider] {
			continue // skip aliases
		}
		if prev, ok := seen[envVar]; ok {
			t.Errorf("ProviderEnvAliases has duplicate env var %q for known providers %q and %q", envVar, prev, provider)
		}
		seen[envVar] = provider
	}
}

// ──────────────────────────────────────────────
// Phase 2: Application — auth envvars subcommand
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
	for _, suspicious := range []string{"sk-", "sk-ant"} {
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

func TestProviderEnvAliases_roundTrip(t *testing.T) {
	aliases := ProviderEnvAliases()

	var lines []string
	for provider, envVar := range aliases {
		lines = append(lines, provider+"="+envVar)
	}

	for provider := range aliases {
		found := false
		for _, line := range lines {
			if strings.HasPrefix(line, provider+"=") {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("formatted output missing provider %q", provider)
		}
	}
}

func TestProviderEnvAliases_nonAliasEntryCount(t *testing.T) {
	aliases := ProviderEnvAliases()

	knownSet := make(map[string]bool)
	for _, name := range ProviderNames() {
		knownSet[name] = true
	}

	nonAliasCount := 0
	for provider := range aliases {
		if knownSet[provider] {
			nonAliasCount++
		}
	}

	if nonAliasCount != len(ProviderNames()) {
		t.Errorf("non-alias entry count = %d, want %d (num known providers)", nonAliasCount, len(ProviderNames()))
	}
}
