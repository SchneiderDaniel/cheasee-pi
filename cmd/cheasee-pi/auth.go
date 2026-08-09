package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"

	"charm.land/huh/v2"
	"github.com/spf13/cobra"
)

var (
	authAddWorkdir    string
	authAddNoInput    bool
	authRemoveWorkdir string
	authListWorkdir   string
)

var authCmd = &cobra.Command{
	Use:   "auth",
	Short: "Manage provider API keys",
	Long: `Manage API keys for pi providers.

Add, remove, or list configured provider API keys. Keys are stored in
~/.config/cheasee-pi/auth.json and also written to workspace settings
(cheasee-settings.json and .pi/agent/settings.json).`,
}

var authAddCmd = &cobra.Command{
	Use:   "add [provider]",
	Short: "Add or update a provider API key",
	Long: `Add or update a provider API key.

If provider name is given as argument, use it directly. Otherwise
prompt from a list of known providers.

The key is saved to ~/.config/cheasee-pi/auth.json and also written
to the workspace cheasee-settings.json and .pi/agent/settings.json as
the default provider (last added becomes default).

Examples:
  cheasee-pi auth add                    # interactive provider picker
  cheasee-pi auth add opencode-go        # add opencode-go key
  cheasee-pi auth add openai --no-input  # prompt only for key, skip model`,
	Args: cobra.MaximumNArgs(1),
	RunE: runAuthAddE,
}

var authRemoveCmd = &cobra.Command{
	Use:   "remove <provider>",
	Short: "Remove a provider API key",
	Args:  cobra.ExactArgs(1),
	RunE:  runAuthRemoveE,
}

var authListCmd = &cobra.Command{
	Use:   "list",
	Short: "List configured providers",
	RunE:  runAuthListE,
}

var authEnvvarsFormat string

var authEnvvarsCmd = &cobra.Command{
	Use:   "envvars",
	Short: "Print provider→envvar mapping",
	Long: `Print the provider-to-environment-variable mapping.

Shell format (default) prints one PROVIDER=ENV_VAR per line suitable
for sourcing into bash as an associative array:

  cheasee-pi auth envvars
  # opencode-go=OPENCODE_API_KEY
  # openai=OPENAI_API_KEY
  # ...

JSON format prints the same mapping as a JSON object:

  cheasee-pi auth envvars --format json

This is the canonical mapping. The shell auth-env.sh derives its
provider_to_envvar from this subcommand. No API key values are emitted.`,
	Args: cobra.NoArgs,
	RunE: runAuthEnvvarsE,
}

func init() {
	rootCmd.AddCommand(authCmd)
	authCmd.AddCommand(authAddCmd, authRemoveCmd, authListCmd, authEnvvarsCmd)

	authAddCmd.Flags().StringVar(&authAddWorkdir, "workdir", "", "Working directory of a cheasee-pi workspace (default: current directory)")
	authAddCmd.Flags().BoolVar(&authAddNoInput, "no-input", false, "Skip model selection prompt")

	authRemoveCmd.Flags().StringVar(&authRemoveWorkdir, "workdir", "", "Working directory of a cheasee-pi workspace (default: current directory)")

	authListCmd.Flags().StringVar(&authListWorkdir, "workdir", "", "Working directory of a cheasee-pi workspace (default: current directory)")

	authEnvvarsCmd.Flags().StringVar(&authEnvvarsFormat, "format", "shell", "Output format: shell or json")
}

// resolveWorkdir returns the workdir from flag or CWD.
func resolveWorkdir(workdirFlag string) (string, error) {
	if workdirFlag != "" {
		return workdirFlag, nil
	}
	return os.Getwd()
}

// runAuthAddE handles cheasee-pi auth add [provider].
func runAuthAddE(cmd *cobra.Command, args []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}

	provider := ""
	if len(args) > 0 {
		provider = args[0]
	}

	workdir, err := resolveWorkdir(authAddWorkdir)
	if err != nil {
		return fmt.Errorf("resolve workdir: %w", err)
	}

	// Pick provider if not specified
	if provider == "" {
		picked, err := promptProvider()
		if err != nil {
			return err
		}
		provider = picked
	}

	// Prompt for API key
	key, err := promptAPIKeyForProvider(provider)
	if err != nil {
		return err
	}

	// Save to auth.json
	repo := &fileRepository{}
	if err := repo.AddProvider(ctx, provider, key); err != nil {
		return fmt.Errorf("save provider key: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Saved %q to auth.json\n", provider)

	// Pick default model
	model := DefaultModel(provider)
	knownModels := KnownModels[provider]
	if !authAddNoInput && len(knownModels) > 0 {
		picked, err := promptModel(provider, knownModels)
		if err != nil {
			return err
		}
		if picked != "" {
			model = picked
		}
	}

	// Update workspace settings (last added = default)
	sw := &SettingsWriter{Workdir: workdir}
	if err := sw.WriteDefaultProvider(provider, model); err != nil {
		return fmt.Errorf("update workspace settings: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Set as default provider in workspace settings (model: %s)\n", model)

	return nil
}

// runAuthRemoveE handles cheasee-pi auth remove <provider>.
func runAuthRemoveE(cmd *cobra.Command, args []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}

	provider := args[0]

	repo := &fileRepository{}
	if err := repo.RemoveProvider(ctx, provider); err != nil {
		return fmt.Errorf("remove provider: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Removed %q from auth.json\n", provider)

	// Note: workspace settings defaultProvider stays; user may have
	// multiple providers and removing one doesn't necessarily change default.
	// If they want to change default, use `auth add <other>`.

	return nil
}

// runAuthListE handles cheasee-pi auth list.
func runAuthListE(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}

	repo := &fileRepository{}
	providers, err := repo.ListProviders(ctx)
	if err != nil {
		return fmt.Errorf("list providers: %w", err)
	}

	if len(providers) == 0 {
		fmt.Fprintf(os.Stderr, "No providers configured.\n")
		fmt.Fprintf(os.Stderr, "Use: cheasee-pi auth add <provider>\n")
		return nil
	}

	fmt.Fprintf(os.Stderr, "Configured providers:\n")
	for name, key := range providers {
		masked := maskKey(key)
		fmt.Fprintf(os.Stderr, "  %-15s %s\n", name, masked)
	}

	// Also show workspace default if available — read from the dedicated
	// cheasee-settings.json (single source for the default provider).
	workdir, err := resolveWorkdir(authListWorkdir)
	if err == nil {
		if settings, err := LoadCheaseeSettings(workdir); err == nil && settings.DefaultProvider != "" {
			fmt.Fprintf(os.Stderr, "\nDefault provider (from cheasee-settings.json): %s\n", settings.DefaultProvider)
			if settings.DefaultModel != "" {
				fmt.Fprintf(os.Stderr, "Default model: %s\n", settings.DefaultModel)
			}
		}
	}

	return nil
}

// ──────────────────────────────────────────────
// Prompt helpers
// ──────────────────────────────────────────────

// promptProvider shows a picker of known providers and returns the selection.
func promptProvider() (string, error) {
	providers := ProviderNames()
	opts := make([]huh.Option[string], len(providers))
	for i, p := range providers {
		opts[i] = huh.NewOption(p, p)
	}

	var selected string
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Provider").
				Description("Choose a model provider").
				Options(opts...).
				Value(&selected),
		),
	)
	if err := form.Run(); err != nil {
		return "", err
	}
	return selected, nil
}

// promptAPIKeyForProvider prompts for an API key with masked input.
func promptAPIKeyForProvider(provider string) (string, error) {
	var key string
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title(fmt.Sprintf("API Key for %s", provider)).
				Description("Paste your API key below. It is stored in ~/.config/cheasee-pi/auth.json.\nGet your key at the provider's dashboard.").
				Prompt("API key: ").
				Value(&key),
		),
	)
	if err := form.Run(); err != nil {
		return "", err
	}
	return key, nil
}

// promptModel shows a picker of known models for a provider and returns the selection.
// If user selects "custom", they can type a custom model name.
func promptModel(provider string, models []string) (string, error) {
	opts := make([]huh.Option[string], 0, len(models)+1)
	for _, m := range models {
		opts = append(opts, huh.NewOption(m, m))
	}
	opts = append(opts, huh.NewOption("Custom (type your own)", "__custom__"))

	var selected string
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title(fmt.Sprintf("Default model for %s", provider)).
				Description("Choose the default model for this provider").
				Options(opts...).
				Value(&selected),
		),
	)
	if err := form.Run(); err != nil {
		return "", err
	}

	if selected == "__custom__" {
		var custom string
		customForm := huh.NewForm(
			huh.NewGroup(
				huh.NewInput().
					Title("Custom model name").
					Description("Enter the model identifier (e.g., gpt-4o-custom)").
					Value(&custom),
			),
		)
		if err := customForm.Run(); err != nil {
			return "", err
		}
		return custom, nil
	}

	return selected, nil
}

// ──────────────────────────────────────────────
// auth envvars — emit canonical provider→envvar mapping
// ──────────────────────────────────────────────

// runAuthEnvvarsE handles cheasee-pi auth envvars.
func runAuthEnvvarsE(cmd *cobra.Command, _ []string) error {
	aliases := ProviderEnvAliases()

	switch authEnvvarsFormat {
	case "shell":
		return emitShellMapping(cmd, aliases)
	case "json":
		return emitJSONMapping(cmd, aliases)
	default:
		return fmt.Errorf("unknown format %q; use 'shell' or 'json'", authEnvvarsFormat)
	}
}

func emitShellMapping(cmd *cobra.Command, aliases map[string]string) error {
	providers := make([]string, 0, len(aliases))
	for p := range aliases {
		providers = append(providers, p)
	}
	sort.Strings(providers)

	for _, p := range providers {
		fmt.Fprintf(cmd.OutOrStdout(), "%s=%s\n", p, aliases[p])
	}
	return nil
}

func emitJSONMapping(cmd *cobra.Command, aliases map[string]string) error {
	// Sort keys for deterministic output
	providers := make([]string, 0, len(aliases))
	for p := range aliases {
		providers = append(providers, p)
	}
	sort.Strings(providers)

	ordered := make(map[string]string, len(aliases))
	for _, p := range providers {
		ordered[p] = aliases[p]
	}

	enc := json.NewEncoder(cmd.OutOrStdout())
	enc.SetIndent("", "  ")
	return enc.Encode(ordered)
}

// maskKey shows first 4 and last 4 chars of a key for display.
func maskKey(key string) string {
	if len(key) <= 8 {
		return "****"
	}
	return key[:4] + "..." + key[len(key)-4:]
}
