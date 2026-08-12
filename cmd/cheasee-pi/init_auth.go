package main

import (
	"context"
	"fmt"
	"os"

	"charm.land/huh/v2"
)

// runInitAuth performs GitHub OAuth device flow authentication and resolves
// the GitHub login via GET /user with the in-memory token. The lookup is
// fail-open: OAuth already succeeded, so an error (or empty login) only
// warns on stderr and yields an empty user — repository.user stays empty
// ("when available").
func runInitAuth(ctx context.Context, authenticator Authenticator) (token, user string, err error) {
	fmt.Fprintf(os.Stderr, "\n🔐 GitHub Authentication\n")
	fmt.Fprintf(os.Stderr, "   ─────────────────────\n")
	fmt.Fprintf(os.Stderr, "   ⚠ SECURITY: Only enter the code at https://github.com/login/device\n")
	fmt.Fprintf(os.Stderr, "   Do NOT search for this URL — type it directly.\n\n")

	code, err := authenticator.RequestCode(ctx, []string{"repo", "read:org"})
	if err != nil {
		return "", "", fmt.Errorf("device code request failed: %w", err)
	}

	fmt.Fprintf(os.Stderr, "   ┌──────────────────────────────────────┐\n")
	fmt.Fprintf(os.Stderr, "   │                                      │\n")
	fmt.Fprintf(os.Stderr, "   │  Code: %-12s               │\n", code.UserCode)
	fmt.Fprintf(os.Stderr, "   │  URL:  %-32s  │\n", code.VerificationURI)
	fmt.Fprintf(os.Stderr, "   │                                      │\n")
	fmt.Fprintf(os.Stderr, "   └──────────────────────────────────────┘\n\n")
	fmt.Fprintf(os.Stderr, "   Opening browser: %s\n", code.VerificationURI)

	accessToken, err := authenticator.Wait(ctx, code)
	if err != nil {
		return "", "", fmt.Errorf("device flow wait failed: %w", err)
	}

	fmt.Fprintf(os.Stderr, "  ✓ GitHub authentication successful\n")

	user, err = authenticator.User(ctx, accessToken.Token)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ GitHub user lookup failed (continuing without it): %v\n", err)
		return accessToken.Token, "", nil
	}
	return accessToken.Token, user, nil
}

// runInitAPIKeys guides the user through configuring API keys for pi providers.
// Called after the main init flow (GitHub auth + scaffold), only in interactive mode.
// Each provider key is saved to auth.json. Last provider added becomes default in
// workspace settings. Skips if Docker Engine check failed or workspace has no .pi dir.
func runInitAPIKeys(ctx context.Context, cfg *fileRepository, workdir string, confirmFn func(string) (bool, error)) error {
	ok, err := confirmFn("Configure API keys for pi providers?")
	if err != nil {
		return err
	}
	if !ok {
		fmt.Fprintf(os.Stderr, "  ℹ Skipping API key setup. Use 'cheasee-pi auth add' later.\n")
		return nil
	}

	fmt.Fprintf(os.Stderr, "\n🔑 Provider API Keys\n")
	fmt.Fprintf(os.Stderr, "   ───────────────────\n")
	fmt.Fprintf(os.Stderr, "   Keys are stored in ~/.config/cheasee-pi/auth.json\n")
	fmt.Fprintf(os.Stderr, "   The last provider you add becomes the default.\n\n")

	sw := &SettingsWriter{Workdir: workdir}
	lastProvider := ""
	lastModel := ""

	for {
		provider, err := promptProvider()
		if err != nil {
			return err
		}

		key, err := promptAPIKeyForProvider(provider)
		if err != nil {
			return err
		}

		if err := cfg.AddProvider(ctx, provider, key); err != nil {
			return fmt.Errorf("save %q: %w", provider, err)
		}
		fmt.Fprintf(os.Stderr, "  ✓ Saved %q to auth.json\n", provider)

		model := DefaultModel(provider)
		if models, ok := KnownModels[provider]; ok && len(models) > 0 {
			picked, err := promptModel(provider, models)
			if err != nil {
				return err
			}
			if picked != "" {
				model = picked
			}
		}

		lastProvider = provider
		lastModel = model

		more, err := confirmFn("Add another provider?")
		if err != nil {
			return err
		}
		if !more {
			break
		}
	}

	// Last provider added becomes default
	if lastProvider != "" {
		if err := sw.WriteDefaultProvider(lastProvider, lastModel); err != nil {
			return fmt.Errorf("update workspace settings: %w", err)
		}
		fmt.Fprintf(os.Stderr, "  ✓ Default provider set to %q (model: %s)\n", lastProvider, lastModel)
	}

	return nil
}

// runInitLegacy is an auth-only helper that returns an *Auth with the API key.
// It does NOT save, extract, or render — the orchestrator handles those.
func runInitLegacy(ctx context.Context, cfg *fileRepository, apiKey string, provider string) (*Auth, error) {
	if apiKey == "" {
		key, err := promptAPIKey(provider)
		if err != nil {
			return nil, fmt.Errorf("API key prompt failed: %w", err)
		}
		apiKey = key
	}

	return &Auth{APIKey: apiKey, Provider: provider}, nil
}

// promptAPIKey prompts the user for an API key (legacy).
func promptAPIKey(provider string) (string, error) {
	var apiKey string
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("API Key").
				Description("Provider: " + provider + " (set via --provider)\nGet your key at the provider's dashboard and paste it below.").
				Prompt("Paste your API key: ").
				Value(&apiKey),
		),
	)
	err := form.Run()
	return apiKey, err
}
