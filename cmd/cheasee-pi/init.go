package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/cli/oauth/device"
	"github.com/spf13/cobra"
)

// nextStepHint is the post-init instruction printed after a successful init run.
// It is a constant so both the CLI and documentation stay in sync.
const nextStepHint = "cheasee-pi start"

var (
	initAPIKey        string
	initNoDockerCheck bool
	initWorkdir       string
	initNoGitHub      bool
	initClientID      string
	initProvider      string
	initNoInput       bool
)

// InitPorts bundles the injected port interfaces used by runInit.
// Only genuine seams (network/external-service boundaries) keep interfaces;
// docker/git CLI, auth config, and in-process stdlib adapters are package-level
// or called directly by the phase functions.
type InitPorts struct {
	Auth Authenticator
}

// InitDeps bundles all dependencies, flags, and callbacks for runInit.
type InitDeps struct {
	Ports         InitPorts
	APIKey        string
	NoDockerCheck bool
	NoGitHub      bool
	NoInput       bool
	Workdir       string
	ConfirmFn     func(string) (bool, error)
	InputFn       func(title, placeholder string) (string, error)
}

// Validate checks that all required dependencies for the active path are non-nil.
func (d InitDeps) Validate() error {
	var missing []string
	if !d.NoGitHub && d.Ports.Auth == nil {
		missing = append(missing, "Ports.Auth")
	}
	if len(missing) > 0 {
		return fmt.Errorf("init: missing required deps: %s", strings.Join(missing, ", "))
	}
	return nil
}

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize cheasee-pi configuration",
	Long: `Initialize cheasee-pi by authenticating with GitHub and scaffolding
.pi/settings.json into your repository.

The init command will:
  1. Verify Docker Engine 24.0+ is installed and running
  2. Authenticate with GitHub via OAuth device flow (or use --api-key with --no-github)
  3. Scaffold .pi/settings.json with cheasee-pi defaults (never overwrites)

No fork, no clone, no docker files in your repo — compose and Dockerfile are
CLI-managed cache state. Run 'cheasee-pi start' from your git repository to
launch pi.

After init, manage API keys with:
  cheasee-pi auth add <provider>
  cheasee-pi auth list
  cheasee-pi auth remove <provider>

GitHub OAuth is the primary authentication method. Use --no-github to fall
back to the legacy API-key-only path.`,
	DisableAutoGenTag: true,
	RunE:              runInitE,
}

func init() {
	rootCmd.AddCommand(initCmd)
	initCmd.Flags().StringVar(&initAPIKey, "api-key", "", "API key (skips interactive prompt)")
	initCmd.Flags().BoolVar(&initNoDockerCheck, "no-docker-check", false, "Skip Docker Engine check")
	initCmd.Flags().StringVar(&initWorkdir, "workdir", "", "Working directory (default: current directory)")
	initCmd.Flags().BoolVar(&initNoGitHub, "no-github", false, "Use legacy API-key-only path (skip GitHub OAuth)")
	initCmd.Flags().StringVar(&initClientID, "client-id", "178c6fc778ccc68e1d6a", "GitHub OAuth client ID")
	initCmd.Flags().StringVar(&initProvider, "provider", "opencode-go", "Provider name for API key (e.g. opencode-go, openai, anthropic)")
	initCmd.Flags().BoolVar(&initNoInput, "no-input", false, "Skip all interactive prompts")
}

// runInitE wires up the real dependencies and calls runInit.
func runInitE(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
	}

	workdir := initWorkdir
	if workdir == "" {
		var err error
		workdir, err = os.Getwd()
		if err != nil {
			return fmt.Errorf("get working directory: %w", err)
		}
	}

	// Wire up remaining ports (docker/git CLI and auth config are package-level)
	authenticator := NewAuthenticator(initClientID)
	confirmFn := promptConfirm
	inputFn := promptInput

	return runInit(ctx, InitDeps{
		Ports:         InitPorts{Auth: authenticator},
		APIKey:        initAPIKey,
		NoDockerCheck: initNoDockerCheck,
		NoGitHub:      initNoGitHub,
		NoInput:       initNoInput,
		Workdir:       workdir,
		ConfirmFn:     confirmFn,
		InputFn:       inputFn,
	})
}

// runInit is the orchestrator that sequences all init phases.
func runInit(ctx context.Context, deps InitDeps) error {
	if err := deps.Validate(); err != nil {
		return err
	}
	// Phase 1: Docker check (unless --no-docker-check)
	if !deps.NoDockerCheck {
		if err := runInitDockerCheck(ctx); err != nil {
			return err
		}
	}

	// Phase 2: Probe existing setup
	proceed, err := runInitProbe(ctx, deps.Workdir, deps.ConfirmFn, deps.NoInput)
	if err != nil {
		return err
	}
	if !proceed {
		fmt.Fprintln(os.Stderr, "Init cancelled.")
		return nil
	}

	// Auth config is file I/O under the OS user config dir — no port.
	cfg := &fileRepository{}

	// Phase 3: Authentication
	var auth *Auth
	if deps.NoGitHub {
		// Legacy path: API key only
		fmt.Fprintf(os.Stderr, "  ℹ Using API-key-only mode.\n")
		fmt.Fprintf(os.Stderr, "  ℹ Provider: %s\n", initProvider)
		auth, err = runInitLegacy(ctx, cfg, deps.APIKey, initProvider)
		if err != nil {
			return err
		}
		auth.RepoPath = deps.Workdir
	} else {
		token, user, err := runInitAuth(ctx, deps.Ports.Auth)
		if err != nil {
			if errors.Is(err, device.ErrUnsupported) {
				fmt.Fprintf(os.Stderr, "  ⚠ GitHub OAuth device flow unavailable (the configured OAuth app may be invalid).\n")
				fmt.Fprintf(os.Stderr, "  ℹ Falling back to API-key-only mode. Use --client-id to provide your own GitHub OAuth app.\n\n")
				auth, err = runInitLegacy(ctx, cfg, deps.APIKey, initProvider)
				if err != nil {
					return err
				}
				auth.RepoPath = deps.Workdir
			} else {
				return fmt.Errorf("GitHub authentication failed: %w", err)
			}
		} else {
			auth = &Auth{
				GitHubToken: token,
				GitHubUser:  user,
				RepoPath:    deps.Workdir,
			}
		}
	}

	// Phase 4: Scaffold .pi/settings.json (never overwrites)
	if err := runInitScaffold(ctx, deps.Workdir, deps.ConfirmFn); err != nil {
		return fmt.Errorf("settings scaffold: %w", err)
	}

	// Phase 5: Save auth config
	if err := cfg.Save(ctx, auth); err != nil {
		return fmt.Errorf("save auth config: %w", err)
	}

	path, _ := cfg.Path()
	fmt.Fprintf(os.Stderr, "  ✓ Auth config saved to %s\n", path)

	// Phase 6: API key setup for pi providers (interactive only)
	if !deps.NoInput {
		if err := runInitAPIKeys(ctx, cfg, deps.Workdir, deps.ConfirmFn); err != nil {
			return fmt.Errorf("API key setup: %w", err)
		}
	}

	fmt.Fprintf(os.Stderr, "\n✅ Init complete! Next step:\n")
	fmt.Fprintf(os.Stderr, "   %s\n", nextStepHint)
	return nil
}

// runInitProbe checks for an existing .pi/settings.json and prompts the user.
// If noInput is true, skips the confirm prompt and proceeds.
func runInitProbe(ctx context.Context, workdir string, confirmFn func(string) (bool, error), noInput bool) (bool, error) {
	if noInput {
		// Non-interactive: proceed without prompting
		return true, nil
	}

	if _, err := os.Stat(settingsPath(workdir)); err == nil {
		ok, err := confirmFn("Existing .pi/settings.json detected. Re-apply configuration?")
		if err != nil {
			return false, err
		}
		return ok, nil
	}
	return true, nil
}
