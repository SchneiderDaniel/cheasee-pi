package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"charm.land/huh/v2"
	"github.com/cli/oauth/device"
)

// runInitAuth performs GitHub OAuth device flow authentication.
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
	return accessToken.Token, "", nil
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

// runReauth re-runs the authentication phases on an already-initialized
// workspace (cheasee-settings.json present + --reauth): GitHub OAuth device
// flow with user resolution, a merge-safe patch of github_token /
// github_user / repo_path in auth.json, then the pi provider API-key setup.
// The clone/scaffold phases are skipped — the workspace is already set up.
// Standalone so a future `auth redo` command can delegate to it.
func runReauth(ctx context.Context, deps InitDeps) error {
	// Fail closed: malformed settings means the workspace identity cannot be
	// confirmed — abort before any auth change.
	if _, err := LoadCheaseeSettings(deps.Workdir); err != nil {
		return fmt.Errorf("reauth: read cheasee-settings.json: %w", err)
	}

	cfg := &fileRepository{}

	fmt.Fprintf(os.Stderr, "\n🔄 Re-authenticating initialized workspace\n")

	// Interactive runs require an explicit confirmation before credentials
	// are replaced; --no-input treats the flag itself as the confirmation
	// (same convention as the full init flow).
	if !deps.NoInput {
		ok, err := deps.ConfirmFn("Replace the stored GitHub/API-key credentials?")
		if err != nil {
			return err
		}
		if !ok {
			fmt.Fprintf(os.Stderr, "  ℹ Re-auth cancelled — credentials left unchanged.\n")
			return nil
		}
	}

	// GitHub device flow. On an initialized workspace ErrUnsupported is a
	// hard error with a --client-id hint — the legacy API-key fallback (which
	// re-prompts providers and rewrites the default provider) is wrong here.
	if !deps.NoGitHub {
		token, _, err := runInitAuth(ctx, deps.Ports.Auth)
		if err != nil {
			if errors.Is(err, device.ErrUnsupported) {
				return fmt.Errorf("GitHub OAuth device flow unavailable — the configured OAuth app may be invalid; use --client-id to provide your own GitHub OAuth app (re-auth does not fall back to API-key-only mode)")
			}
			return fmt.Errorf("GitHub authentication failed: %w", err)
		}

		user, err := resolveGitHubUser(ctx, token)
		if err != nil {
			return fmt.Errorf("resolve GitHub user: %w", err)
		}

		// Merge-safe raw-map patch: preserves every provider entry and the
		// legacy flat api_key (a Load→Save round-trip would drop all but one
		// provider — Auth.UnmarshalJSON keeps only the last).
		if err := cfg.UpdateGitHubAuth(ctx, token, user, deps.Workdir); err != nil {
			return fmt.Errorf("update auth config: %w", err)
		}
		fmt.Fprintf(os.Stderr, "  ✓ GitHub credentials updated for %s\n", user)

		// OAuth App tokens never expire — the superseded token stays live
		// until the user revokes the app.
		fmt.Fprintf(os.Stderr, "  ℹ Superseded GitHub OAuth tokens never expire. Revoke the old token at:\n")
		fmt.Fprintf(os.Stderr, "     https://github.com/settings/connections/applications\n")
	}

	// Provider API-key setup (interactive only, same convention as init).
	if !deps.NoInput {
		if err := runInitAPIKeys(ctx, cfg, deps.Workdir, deps.ConfirmFn); err != nil {
			return fmt.Errorf("API key setup: %w", err)
		}
	}

	fmt.Fprintf(os.Stderr, "\n✅ Re-auth complete! Next step:\n")
	fmt.Fprintf(os.Stderr, "   %s\n", nextStepHint)
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
