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
// If the script path changes, update both init.go and
// docs/installation.md in lockstep.
const nextStepHint = "bash docker/run-pi.sh"

var (
	initAPIKey         string
	initNoDockerCheck  bool
	initWorkdir        string
	initSourceRepo     string
	initNoGitHub       bool
	initClientID       string
	initProvider       string
	initSkipFork       bool
	initForkURL        string
	initNoInput        bool
	initSubmoduleURLs  []string
	initSkipSubmodules bool
)

// SourceForkMode controls how the fork source is determined.
type SourceForkMode int

const (
	ModePromptFork SourceForkMode = iota
	ModeUseForkURL
	ModeSkipFork
)

// SourceForkInput carries the fork source configuration.
type SourceForkInput struct {
	Mode       SourceForkMode
	SourceRepo string
	ForkURL    string
}

// InitPorts bundles the injected port interfaces used by runInit.
// Only genuine seams (network/external-service boundaries) keep interfaces;
// docker/git CLI, auth config, and in-process stdlib adapters are package-level
// or called directly by the phase functions.
type InitPorts struct {
	Auth   Authenticator
	GitHub GitHubClient
}

// InitDeps bundles all dependencies, flags, and callbacks for runInit.
type InitDeps struct {
	Ports             InitPorts
	SubmoduleOps      submoduleOps // go-git submodule ops; nil → gitSubmoduleOps
	APIKey            string
	NoDockerCheck     bool
	NoGitHub          bool
	NoInput           bool
	SkipSubmodules    bool
	SourceFork        SourceForkInput
	Workdir           string
	SubmoduleURLs     map[string]string
	ConfirmFn         func(string) (bool, error)
	InputFn           func(title, placeholder string) (string, error)
	SubmodulePromptFn func([]Submodule) (map[string]string, error)
}

// Validate checks that all required dependencies for the active path are non-nil.
func (d InitDeps) Validate() error {
	var missing []string
	if !d.NoGitHub {
		if d.Ports.Auth == nil {
			missing = append(missing, "Ports.Auth")
		}
		if d.Ports.GitHub == nil {
			missing = append(missing, "Ports.GitHub")
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("init: missing required deps: %s", strings.Join(missing, ", "))
	}
	return nil
}

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize cheasee-pi configuration",
	Long: `Initialize cheasee-pi by authenticating with GitHub, setting up your repo,
and extracting compose files for Docker deployment.

The init command will:
  1. Verify Docker Engine 24.0+ is installed and running
  2. Authenticate with GitHub via OAuth device flow (or use --api-key with --no-github)
  3. Fork and clone the cheasee-pi repository
  4. Configure the pi submodule for your fork
  5. Extract embedded docker-compose.yml, Dockerfile, and entrypoint.sh
  6. Generate docker/.env with host UID/GID and git identity
  7. Configure API keys for pi providers (interactive)

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
	initCmd.Flags().StringVar(&initSourceRepo, "source-repo", "", "Source repository to fork (default: SchneiderDaniel/cheasee-pi)")
	initCmd.Flags().BoolVar(&initNoGitHub, "no-github", false, "Use legacy API-key-only path (skip GitHub OAuth)")
	initCmd.Flags().StringVar(&initClientID, "client-id", "178c6fc778ccc68e1d6a", "GitHub OAuth client ID")
	initCmd.Flags().StringVar(&initProvider, "provider", "opencode-go", "Provider name for API key (e.g. opencode-go, openai, anthropic)")
	initCmd.Flags().BoolVar(&initSkipFork, "skip-fork", false, "Skip fork step, use existing repo")
	initCmd.Flags().StringVar(&initForkURL, "fork-url", "", "Specify existing fork URL (skip fork and clone)")
	initCmd.Flags().BoolVar(&initNoInput, "no-input", false, "Skip all interactive prompts")
	initCmd.Flags().StringArrayVar(&initSubmoduleURLs, "submodule-url", nil, "Override submodule URL (repeatable, format: name=url)")
	initCmd.Flags().BoolVar(&initSkipSubmodules, "skip-submodules", false, "Skip all submodule setup")
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

	submoduleURLs, err := parseSubmoduleURLs(initSubmoduleURLs)
	if err != nil {
		return fmt.Errorf("parse submodule URLs: %w", err)
	}

	// Wire up remaining ports (docker/git CLI and auth config are package-level)
	authenticator := NewAuthenticator(initClientID)
	gitHubClient := NewGitHubClient()
	confirmFn := promptConfirm
	inputFn := promptInput

	// Build source fork input from flags
	var sourceForkInput SourceForkInput
	switch {
	case initForkURL != "":
		sourceForkInput = SourceForkInput{
			Mode:       ModeUseForkURL,
			SourceRepo: initSourceRepo,
			ForkURL:    initForkURL,
		}
	case initSkipFork:
		sourceForkInput = SourceForkInput{
			Mode:       ModeSkipFork,
			SourceRepo: initSourceRepo,
		}
	default:
		sourceForkInput = SourceForkInput{
			Mode:       ModePromptFork,
			SourceRepo: initSourceRepo,
		}
	}

	return runInit(ctx, InitDeps{
		Ports: InitPorts{
			Auth:   authenticator,
			GitHub: gitHubClient,
		},
		APIKey:            initAPIKey,
		NoDockerCheck:     initNoDockerCheck,
		NoGitHub:          initNoGitHub,
		NoInput:           initNoInput,
		SkipSubmodules:    initSkipSubmodules,
		SourceFork:        sourceForkInput,
		Workdir:           workdir,
		SubmoduleURLs:     submoduleURLs,
		ConfirmFn:         confirmFn,
		InputFn:           inputFn,
		SubmodulePromptFn: promptSubmoduleURLs,
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

	// Phase 2: Probe existing working directory
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

	// Phase 3-8: Authentication and repository setup
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
		// Phase 3: GitHub OAuth device flow
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
			// Phase 4: Get authenticated user identity
			if user == "" {
				u, err := deps.Ports.GitHub.GetAuthenticatedUser(ctx, token)
				if err != nil {
					return fmt.Errorf("get GitHub user: %w", err)
				}
				user = u
			}

			// Phase 4.5: Resolve source repo
			resolvedSourceRepo, err := runInitPromptSource(deps.SourceFork)
			if err != nil {
				return fmt.Errorf("source repo prompt: %w", err)
			}

			// Determine clone URL and whether to fork
			var cloneURL string
			switch deps.SourceFork.Mode {
			case ModeUseForkURL:
				// Use user-supplied fork URL directly — skip fork and wait
				cloneURL = deps.SourceFork.ForkURL
				if err := runInitCloneSubmodule(ctx, token, cloneURL, deps.Workdir); err != nil {
					return err
				}

			case ModeSkipFork:
				// Skip fork and clone entirely

			case ModePromptFork:
				sourceOwner, sourceRepoName := ParseGitHubURL(resolvedSourceRepo)

				// Ask if user wants their own fork
				createFork := true
				if !deps.NoInput {
					ok, err := deps.ConfirmFn(fmt.Sprintf("Create your own fork of %s/%s?", sourceOwner, sourceRepoName))
					if err != nil {
						return err
					}
					createFork = ok
				}

				if createFork {
					forkOwner := user
					forkRepo := sourceRepoName

					_, err = deps.Ports.GitHub.CreateFork(ctx, token, sourceOwner, sourceRepoName)
					if err != nil {
						// 422 "fork already exists" is not a fatal error
						if strings.Contains(err.Error(), "fork already exists") {
							fmt.Fprintf(os.Stderr, "  ℹ Fork already exists, continuing\n")
						} else {
							return fmt.Errorf("fork repository: %w", err)
						}
					}

					// Phase 6: Wait for fork to be ready
					if err := deps.Ports.GitHub.WaitForkReady(ctx, token, forkOwner, forkRepo); err != nil {
						return fmt.Errorf("wait for fork ready: %w", err)
					}

					// Phase 7: Clone the fork
					cloneURL = fmt.Sprintf("https://github.com/%s/%s.git", forkOwner, forkRepo)
				} else {
					// Use source repo directly
					cloneURL = fmt.Sprintf("https://github.com/%s/%s.git", sourceOwner, sourceRepoName)
				}

				if err := runInitCloneSubmodule(ctx, token, cloneURL, deps.Workdir); err != nil {
					return err
				}
			}

			// Post-clone confirm (skip when noInput is true or fork+clone was skipped)
			if deps.SourceFork.Mode != ModeSkipFork && !deps.NoInput {
				ok, err := deps.ConfirmFn(fmt.Sprintf("Forked/Cloned %s to %s. Continue? [Y/n]", cloneURL, deps.Workdir))
				if err != nil {
					return err
				}
				if !ok {
					fmt.Fprintln(os.Stderr, "Init cancelled.")
					return nil
				}
			}

			// Post-clone cleanup: remove files listed in .initremove
			if deps.SourceFork.Mode != ModeSkipFork {
				if err := NewInitRemover().Remove(deps.Workdir); err != nil {
					return fmt.Errorf("post-clone cleanup: %w", err)
				}
			}

			// Configure submodules for non-skip modes
			if deps.SourceFork.Mode != ModeSkipFork {
				ops := deps.SubmoduleOps
				if ops == nil {
					ops = gitSubmoduleOps{}
				}
				if err := runInitSubmodule(ctx, ops, deps.Workdir, deps.SubmoduleURLs, deps.SkipSubmodules, deps.SubmodulePromptFn, deps.NoInput, deps.ConfirmFn, deps.InputFn); err != nil {
					return fmt.Errorf("submodule config: %w", err)
				}
			}

			auth = &Auth{
				GitHubToken: token,
				GitHubUser:  user,
				RepoPath:    deps.Workdir,
			}
		}
	}

	// Phase 9: Extract embedded compose files (always)
	if err := runInitExtract(ctx, deps.Workdir); err != nil {
		return fmt.Errorf("extract compose files: %w", err)
	}

	// Phase 10: Generate docker/.env (always)
	if err := runInitEnv(ctx, deps.Workdir, deps.ConfirmFn); err != nil {
		return fmt.Errorf("env generation: %w", err)
	}

	// Phase 11: Scaffold workspace — git init (no-github only) + .pi/settings.json (always)
	if deps.NoGitHub {
		if err := runInitGitInit(ctx, deps.Workdir); err != nil {
			return fmt.Errorf("git init: %w", err)
		}
	}
	if err := runInitScaffold(ctx, deps.Workdir, deps.ConfirmFn); err != nil {
		return fmt.Errorf("settings scaffold: %w", err)
	}

	// Phase 12: Save auth config
	if err := cfg.Save(ctx, auth); err != nil {
		return fmt.Errorf("save auth config: %w", err)
	}

	path, _ := cfg.Path()
	fmt.Fprintf(os.Stderr, "  ✓ Auth config saved to %s\n", path)

	// Phase 13: API key setup for pi providers (interactive only)
	if !deps.NoInput {
		if err := runInitAPIKeys(ctx, cfg, deps.Workdir, deps.ConfirmFn); err != nil {
			return fmt.Errorf("API key setup: %w", err)
		}
	}

	fmt.Fprintf(os.Stderr, "\n✅ Init complete! Next step:\n")
	fmt.Fprintf(os.Stderr, "   %s\n", nextStepHint)
	return nil
}

// runInitProbe checks for existing setup and prompts the user.
// If noInput is true, skips the confirm prompt and proceeds.
func runInitProbe(ctx context.Context, workdir string, confirmFn func(string) (bool, error), noInput bool) (bool, error) {
	state, err := NewWorkingDirProbe().Inspect(workdir)
	if err != nil {
		return false, fmt.Errorf("check working directory: %w", err)
	}

	if noInput {
		// Non-interactive: proceed without prompting
		return true, nil
	}

	switch state {
	case WorkdirEmpty:
		return true, nil // No existing setup, proceed
	case WorkdirComplete:
		ok, err := confirmFn("Existing cheasee-pi setup detected. Re-apply configuration?")
		if err != nil {
			return false, err
		}
		return ok, nil
	case WorkdirHasRepo:
		ok, err := confirmFn("Git repository detected but no docker-compose.yml. Re-apply configuration?")
		if err != nil {
			return false, err
		}
		return ok, nil
	case WorkdirHasCompose:
		ok, err := confirmFn("Docker compose files detected but no git repository. Re-apply configuration?")
		if err != nil {
			return false, err
		}
		return ok, nil
	default:
		return true, nil
	}
}

// runInitAuth performs GitHub OAuth device flow authentication.
