package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// KnownModels maps provider names to known model identifiers.
// Used for interactive model selection. Updated as new models release.
var KnownModels = map[string][]string{
	"opencode-go": {"deepseek-v4-flash", "gpt-4o", "claude-sonnet-4-20250514"},
	"openai":      {"gpt-4o", "gpt-4o-mini", "o3", "o4-mini"},
	"anthropic":   {"claude-sonnet-4-20250514", "claude-haiku-3-20250313"},
	"deepseek":    {"deepseek-chat", "deepseek-reasoner"},
	"gemini":      {"gemini-2.5-flash", "gemini-2.5-pro"},
	"groq":        {"llama-3.3-70b-versatile", "mixtral-8x7b-32768"},
	"mistral":     {"mistral-large-latest", "mistral-small-latest"},
	"openrouter":  {"anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"},
	"xai":         {"grok-2", "grok-3"},
	"fireworks":   {"accounts/fireworks/models/llama-v3p3-70b-instruct"},
	"together":     {},
	"cerebras":     {},
}

// ProviderNames returns sorted list of known provider names.
func ProviderNames() []string {
	names := make([]string, 0, len(KnownModels))
	for name := range KnownModels {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// DefaultModel returns the first known model for a provider, or empty string.
func DefaultModel(provider string) string {
	models, ok := KnownModels[provider]
	if !ok || len(models) == 0 {
		return ""
	}
	return models[0]
}

// ──────────────────────────────────────────────
// SettingsWriter — updates workspace settings files
// ──────────────────────────────────────────────

// SettingsWriter writes provider config to .pi/settings.json
// and .pi/agent/settings.json in the given workspace.
type SettingsWriter struct {
	Workdir string
}

// WriteDefaultProvider updates workspace settings files with the given
// default provider and model. Skips files that don't exist (not an error).
func (w *SettingsWriter) WriteDefaultProvider(provider, model string) error {
	if err := w.updatePISettings(provider, model); err != nil {
		return fmt.Errorf("update .pi/settings.json: %w", err)
	}
	if err := w.updateAgentSettings(provider); err != nil {
		return fmt.Errorf("update .pi/agent/settings.json: %w", err)
	}
	return nil
}

func (w *SettingsWriter) updatePISettings(provider, model string) error {
	path := filepath.Join(w.Workdir, ".pi", "settings.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // workspace not initialized, skip
		}
		return err
	}

	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		return err
	}

	settings["defaultProvider"] = provider
	if model != "" {
		settings["defaultModel"] = model
	}

	out, err := json.MarshalIndent(settings, "", "\t")
	if err != nil {
		return err
	}

	return atomicWrite(path, out, 0644)
}

func (w *SettingsWriter) updateAgentSettings(provider string) error {
	path := filepath.Join(w.Workdir, ".pi", "agent", "settings.json")

	// Try reading existing
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			// Create with just defaultProvider
			dir := filepath.Dir(path)
			if err := os.MkdirAll(dir, 0755); err != nil {
				return err
			}
			settings := map[string]string{"defaultProvider": provider}
			out, _ := json.MarshalIndent(settings, "", "\t")
			return atomicWrite(path, out, 0644)
		}
		return err
	}

	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		return err
	}

	settings["defaultProvider"] = provider

	out, err := json.MarshalIndent(settings, "", "\t")
	if err != nil {
		return err
	}

	return atomicWrite(path, out, 0644)
}

// ProviderToEnvVar maps provider name to its canonical env var.
// Canonical source for the provider→envvar mapping. The shell derivation
// in auth-env.sh is generated from this function.
func ProviderToEnvVar(provider string) string {
	switch {
	case provider == "opencode-go" || provider == "opencode":
		return "OPENCODE_API_KEY"
	case provider == "openai":
		return "OPENAI_API_KEY"
	case provider == "anthropic" || provider == "claude":
		return "ANTHROPIC_API_KEY"
	case provider == "deepseek":
		return "DEEPSEEK_API_KEY"
	case provider == "gemini" || provider == "google":
		return "GEMINI_API_KEY"
	case provider == "groq":
		return "GROQ_API_KEY"
	case provider == "mistral":
		return "MISTRAL_API_KEY"
	case provider == "openrouter":
		return "OPENROUTER_API_KEY"
	case provider == "xai":
		return "XAI_API_KEY"
	case provider == "fireworks":
		return "FIREWORKS_API_KEY"
	case provider == "together":
		return "TOGETHER_API_KEY"
	case provider == "cerebras":
		return "CEREBRAS_API_KEY"
	default:
		return ""
	}
}

// ProviderPassthroughNames are env var names not bound to a provider that
// buildEnvFlags passes through from the current process environment when set.
// Adding a provider in KnownModels flows through ProviderEnvAliases to
// buildEnvFlags automatically — do not hard-code provider env names here.
var ProviderPassthroughNames = []string{"GH_TOKEN", "CLOUDFLARE_ACCOUNT_ID"}

// AllEnvVarNames returns the env var names buildEnvFlags probes via os.Getenv:
// the distinct non-empty ProviderEnvAliases() values plus ProviderPassthroughNames.
// ProviderEnvAliases() repeats values across aliases (claude/anthropic →
// ANTHROPIC_API_KEY) and returns "" for unknown providers, so values are
// deduped and empties filtered.
func AllEnvVarNames() []string {
	seen := make(map[string]bool)
	var names []string
	for _, envVar := range ProviderEnvAliases() {
		if envVar != "" && !seen[envVar] {
			seen[envVar] = true
			names = append(names, envVar)
		}
	}
	for _, envVar := range ProviderPassthroughNames {
		if !seen[envVar] {
			seen[envVar] = true
			names = append(names, envVar)
		}
	}
	sort.Strings(names)
	return names
}

// ProviderEnvAliases returns the complete mapping of provider names
// (including documented aliases) to their canonical env var names.
//
// Derived from ProviderNames() (which iterates KnownModels) and documented
// aliases, with each value resolved through ProviderToEnvVar so that adding
// a new provider requires editing only ProviderToEnvVar (and KnownModels if
// model lists matter).
func ProviderEnvAliases() map[string]string {
	m := make(map[string]string, len(KnownModels)+3)
	for _, name := range ProviderNames() {
		m[name] = ProviderToEnvVar(name)
	}
	for alias, canonical := range map[string]string{
		"claude":   "anthropic",
		"google":   "gemini",
		"opencode": "opencode-go",
	} {
		m[alias] = ProviderToEnvVar(canonical)
	}
	return m
}
