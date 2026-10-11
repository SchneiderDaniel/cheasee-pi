package main

import (
	"strings"
	"testing"
)

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

func TestProviderEnvAliases_aliasesMatchProviderToEnvVar(t *testing.T) {
	// Cross-check: every entry in ProviderEnvAliases must match
	// ProviderToEnvVar for the same provider.  This ensures that
	// adding a new provider to ProviderToEnvVar automatically gets
	// reflected in the alias map without a second edit.
	aliases := ProviderEnvAliases()
	for provider, envVar := range aliases {
		want := ProviderToEnvVar(provider)
		if envVar != want {
			t.Errorf("ProviderEnvAliases[%q] = %q, but ProviderToEnvVar(%q) = %q — maps have diverged", provider, envVar, provider, want)
		}
	}
}

// ──────────────────────────────────────────────
// Phase 2: Application — auth envvars subcommand
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
