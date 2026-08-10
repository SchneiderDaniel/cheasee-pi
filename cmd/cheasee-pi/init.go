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

// newInitDeps builds the shared InitDeps used by both `cheasee-pi init`
// (runInitE) and start-triggered init (runUpE's empty-folder branch), so the
// two entry points run byte-identical flows. Package-var seam (newRepository
// pattern): tests replace it to drive either entry point with stubbed
// OAuth/prompt boundaries instead of a real device flow or TTY.
var newInitDeps = func(workdir string) InitDeps {
	return InitDeps{
		Ports:         InitPorts{Auth: NewAuthenticator(initClientID)},
		APIKey:        initAPIKey,
		NoDockerCheck: initNoDockerCheck,
		NoGitHub:      initNoGitHub,
		NoInput:       initNoInput,
		Provider:      initProvider,
		ClientID:      initClientID,
		RepoURL:       initRepoURL,
		Workdir:       workdir,
		ConfirmFn:     promptConfirm,
		InputFn:       promptInput,
	}
}

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
	initRepoURL       string
)

// InitPorts bundles the injected port interfaces used by runInit.
// Only genuine seams (network/external-service boundaries) keep interfaces;
// docker/git CLI, auth config, and in-process stdlib adapters are package-level
// or called directly by the phase functions.
type InitPorts struct {
	Auth Authenticator
}

// InitDeps bundles all dependencies, flags, and callbacks for runInit.
// Provider/ClientID/RepoURL carry the flag-derived init inputs so the
// shared factory (newInitDeps) fully encapsulates them — no package-global
// reads inside the flow (start-triggered init and runInitE run identically).
type InitDeps struct {
	Ports         InitPorts
	APIKey        string
	NoDockerCheck bool
	NoGitHub      bool
	NoInput       bool
	Provider      string
	ClientID      string
	RepoURL       string
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
	Long: `Initialize cheasee-pi in an EMPTY folder — init sets the workspace up
itself: bare clone of your project repo to <parent>/.bare, main worktree in
the folder, and the dedicated cheasee-settings.json scaffolded (gitignored,
machine-local). Presence of cheasee-settings.json marks the workspace
initialized; run 'cheasee-pi start' to launch pi.

The init command will:
  1. Verify Docker Engine 24.0+ is installed and running
  2. Probe the folder — init is empty-folder-only (refuses non-empty dirs)
  3. Ask for your project repo URL (owner/repo or a GitHub URL)
  4. Authenticate with GitHub via OAuth device flow (or use --api-key with --no-github)
  5. Bare-clone + add the main worktree
  6. Scaffold cheasee-settings.json with cheasee-pi defaults (never overwrites)

Existing non-empty folders are intentionally NOT supported — run init in a
fresh empty folder. After init, manage API keys with:
  cheasee-pi auth add <provider>
  cheasee-pi auth list
  cheasee-pi auth remove <provider>

GitHub OAuth is the primary authentication method. Use --no-github to fall
back to the legacy API-key-only path (no clone, no repo URL).`,
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
	initCmd.Flags().StringVar(&initRepoURL, "repo-url", "", "Project repository URL for the empty-folder clone (required with --no-input)")
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

	return runInit(ctx, newInitDeps(workdir))
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

	// Phase 2: empty-folder probe — init is empty-folder-only and refuses when
	// cheasee-settings.json already exists (presence = initialized marker).
	if err := runInitProbe(deps.Workdir); err != nil {
		return err
	}

	// Phase 3: project repo URL (GitHub path only; legacy --no-github skips
	// the clone entirely). Validated before any git call.
	var repoURL string
	if !deps.NoGitHub {
		url, err := resolveRepoURL(deps)
		if err != nil {
			return err
		}
		if owner, repo := ParseGitHubURL(url); owner == "" || repo == "" {
			return fmt.Errorf("invalid repo URL %q — expected owner/repo or a GitHub repository URL", url)
		}
		repoURL = url
	}

	// Auth config is file I/O under the OS user config dir — no port.
	cfg := &fileRepository{}

	// Phase 4: Authentication
	var auth *Auth
	var err error
	if deps.NoGitHub {
		// Legacy path: API key only
		fmt.Fprintf(os.Stderr, "  ℹ Using API-key-only mode.\n")
		fmt.Fprintf(os.Stderr, "  ℹ Provider: %s\n", deps.Provider)
		auth, err = runInitLegacy(ctx, cfg, deps.APIKey, deps.Provider)
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
				auth, err = runInitLegacy(ctx, cfg, deps.APIKey, deps.Provider)
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

	// Phase 5: clone phase — bare clone to <parent>/.bare + main worktree.
	if !deps.NoGitHub {
		if err := gitCloneWorktree(ctx, repoURL, deps.Workdir); err != nil {
			return err
		}
	}

	// Phase 6: Scaffold cheasee-settings.json (never overwrites)
	if err := runInitScaffold(ctx, deps); err != nil {
		return fmt.Errorf("settings scaffold: %w", err)
	}

	// Phase 7: Save auth config
	if err := cfg.Save(ctx, auth); err != nil {
		return fmt.Errorf("save auth config: %w", err)
	}

	path, _ := cfg.Path()
	fmt.Fprintf(os.Stderr, "  ✓ Auth config saved to %s\n", path)

	// Phase 8: API key setup for pi providers (interactive only)
	if !deps.NoInput {
		if err := runInitAPIKeys(ctx, cfg, deps.Workdir, deps.ConfirmFn); err != nil {
			return fmt.Errorf("API key setup: %w", err)
		}
	}

	fmt.Fprintf(os.Stderr, "\n✅ Init complete! Next step:\n")
	fmt.Fprintf(os.Stderr, "   %s\n", nextStepHint)
	return nil
}

// runInitProbe enforces the empty-folder-only init contract: refuses when
// cheasee-settings.json already exists (presence = initialized marker — no
// re-apply prompt) and refuses non-empty folders (cheasee-pi never
// auto-initializes existing folders). .DS_Store is tolerated so
// Finder-touched folders still auto-init. Returns nil to proceed.
func runInitProbe(workdir string) error {
	if _, err := os.Stat(cheaseeSettingsPath(workdir)); err == nil {
		return fmt.Errorf("already initialized: %s exists — run `cheasee-pi start`", cheaseeSettingsPath(workdir))
	}
	entries, err := os.ReadDir(workdir)
	if err != nil {
		return fmt.Errorf("inspect folder: %w", err)
	}
	for _, e := range entries {
		if e.Name() == ".DS_Store" {
			continue
		}
		return fmt.Errorf("init requires an empty folder: %q is not empty (found %q) — cheasee-pi init sets the workspace up itself (bare clone + worktree) and never initializes existing folders", workdir, e.Name())
	}
	return nil
}

// resolveRepoURL returns the project repo URL for the clone phase: the
// --repo-url flag when set, otherwise the interactive InputFn prompt. With
// --no-input and no flag, errors out before any git call.
func resolveRepoURL(deps InitDeps) (string, error) {
	if deps.RepoURL != "" {
		return deps.RepoURL, nil
	}
	if deps.NoInput {
		return "", errors.New("init: --repo-url is required with --no-input (empty-folder init clones a bare repo + worktree)")
	}
	url, err := deps.InputFn("Project repository URL", "https://github.com/owner/repo")
	if err != nil {
		return "", fmt.Errorf("repo URL prompt failed: %w", err)
	}
	url = strings.TrimSpace(url)
	if url == "" {
		return "", errors.New("empty repo URL — expected owner/repo or a GitHub repository URL")
	}
	return url, nil
}
