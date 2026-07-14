package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"charm.land/huh/v2"
	"github.com/spf13/cobra"
)

// nextStepHint is the post-init instruction printed after a successful init run.
// It is a constant so both the CLI and documentation stay in sync.
// If the compose filename or flag shape changes, update both init.go and
// docs/installation.md in lockstep.
const nextStepHint = "docker compose -f docker/docker-compose.yml up -d --build"

var (
	initAPIKey        string
	initNoDockerCheck bool
	initWorkdir       string
	initSourceRepo    string
	initNoGitHub      bool
	initClientID      string
	initProvider      string
)

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
	initCmd.Flags().StringVar(&initSourceRepo, "source-repo", "SchneiderDaniel/cheasee-pi", "Source repository to fork")
	initCmd.Flags().BoolVar(&initNoGitHub, "no-github", false, "Use legacy API-key-only path (skip GitHub OAuth)")
	initCmd.Flags().StringVar(&initClientID, "client-id", "Iv23li6xWD3wR8aJbPP3", "GitHub OAuth client ID")
	initCmd.Flags().StringVar(&initProvider, "provider", "opencode-go", "Provider name for API key (e.g. opencode-go, openai, anthropic)")
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

	dockerChecker := NewChecker(5 * time.Second)
	configRepo := NewRepository()

	// Wire up new ports
	authenticator := NewAuthenticator(initClientID)
	gitHubClient := NewGitHubClient()
	cloner := NewCloner()
	extractor := NewExtractor()
	envRenderer := NewEnvRenderer()
	workdirProbe := NewWorkingDirProbe()
	uidResolver := NewUIDResolver()
	gitIdentity := NewGitIdentity()
	confirmFn := promptConfirm

	return runInit(
		ctx,
		dockerChecker,
		configRepo,
		initAPIKey,
		initNoDockerCheck,
		initNoGitHub,
		initSourceRepo,
		workdir,
		authenticator,
		gitHubClient,
		cloner,
		extractor,
		envRenderer,
		workdirProbe,
		uidResolver,
		gitIdentity,
		confirmFn,
	)
}

// runInit is the orchestrator that sequences all init phases.
func runInit(
	ctx context.Context,
	docker Checker,
	cfg Repository,
	apiKey string,
	noDockerCheck bool,
	noGitHub bool,
	sourceRepo string,
	workdir string,
	authenticator Authenticator,
	gitHubClient GitHubClient,
	cloner Cloner,
	extractor Extractor,
	envRenderer EnvRenderer,
	workdirProbe WorkingDirProbe,
	uidResolver UIDResolver,
	gitIdentity GitIdentity,
	confirmFn func(string) (bool, error),
) error {
	// Phase 1: Docker check (unless --no-docker-check)
	if !noDockerCheck {
		if err := runInitDockerCheck(ctx, docker); err != nil {
			return err
		}
	}

	// Phase 2: Probe existing working directory
	proceed, err := runInitProbe(ctx, workdirProbe, workdir, confirmFn)
	if err != nil {
		return err
	}
	if !proceed {
		fmt.Fprintln(os.Stderr, "Init cancelled.")
		return nil
	}

	// Phase 3-8: Authentication and repository setup
	var auth *Auth
	if noGitHub {
		// Legacy path: API key only
		auth, err = runInitLegacy(ctx, cfg, apiKey, initProvider)
		if err != nil {
			return err
		}
		auth.RepoPath = workdir
	} else {
		// Phase 3: GitHub OAuth device flow
		token, user, err := runInitAuth(ctx, authenticator)
		if err != nil {
			return fmt.Errorf("GitHub authentication failed: %w", err)
		}

		// Phase 4: Get authenticated user identity
		if user == "" {
			u, err := gitHubClient.GetAuthenticatedUser(ctx, token)
			if err != nil {
				return fmt.Errorf("get GitHub user: %w", err)
			}
			user = u
		}

		// Phase 5: Fork the source repository
		sourceOwner, sourceRepoName := ParseGitHubURL(sourceRepo)
		forkOwner := user
		forkRepo := sourceRepoName

		_, err = gitHubClient.CreateFork(ctx, token, sourceOwner, sourceRepoName)
		if err != nil {
			// 422 "fork already exists" is not a fatal error
			if strings.Contains(err.Error(), "fork already exists") {
				fmt.Fprintf(os.Stderr, "  ℹ Fork already exists, continuing\n")
			} else {
				return fmt.Errorf("fork repository: %w", err)
			}
		}

		// Phase 6: Wait for fork to be ready
		if err := gitHubClient.WaitForkReady(ctx, token, forkOwner, forkRepo); err != nil {
			return fmt.Errorf("wait for fork ready: %w", err)
		}

		// Phase 7: Clone the fork
		cloneURL := fmt.Sprintf("https://github.com/%s/%s.git", forkOwner, forkRepo)
		if err := cloner.Clone(ctx, token, cloneURL, workdir); err != nil {
			return fmt.Errorf("clone fork: %w", err)
		}
		fmt.Fprintf(os.Stderr, "  ✓ Cloned %s/%s to %s\n", forkOwner, forkRepo, workdir)

		// Phase 8: Configure submodule
		if err := runInitSubmodule(ctx, cloner, workdir, cloneURL); err != nil {
			return fmt.Errorf("submodule config: %w", err)
		}

		auth = &Auth{
			GitHubToken: token,
			GitHubUser:  user,
			RepoPath:    workdir,
		}
	}

	// Phase 9: Extract embedded compose files (always)
	if err := runInitExtract(ctx, extractor, workdir); err != nil {
		return fmt.Errorf("extract compose files: %w", err)
	}

	// Phase 10: Generate docker/.env (always)
	if err := runInitEnv(ctx, envRenderer, uidResolver, gitIdentity, workdir, confirmFn); err != nil {
		return fmt.Errorf("env generation: %w", err)
	}

	// Phase 11: Save auth config
	if err := cfg.Save(ctx, auth); err != nil {
		return fmt.Errorf("save auth config: %w", err)
	}

	path, _ := cfg.Path()
	fmt.Fprintf(os.Stderr, "  ✓ Auth config saved to %s\n", path)
	fmt.Fprintf(os.Stderr, "\n✅ Init complete! Next step:\n")
	fmt.Fprintf(os.Stderr, "   %s\n", nextStepHint)
	return nil
}

// runInitDockerCheck verifies Docker Engine is installed and running.
func runInitDockerCheck(ctx context.Context, docker Checker) error {
	result, err := docker.Check(ctx)
	if err != nil {
		return fmt.Errorf("docker check failed: %w", err)
	}
	if !result.Installed {
		return fmt.Errorf("Docker is not installed.\n\nPlease install Docker Engine 24.0+ from:\n  https://docs.docker.com/engine/install/")
	}
	if !result.Running {
		return fmt.Errorf("Docker Engine is installed but not running.\n\nPlease start Docker:\n  - Linux: sudo systemctl start docker\n  - macOS: open -a Docker\n  - Windows: Start 'Docker Desktop' from Start Menu")
	}
	if result.Err != nil {
		return fmt.Errorf("Docker version check: %w", result.Err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Docker Engine %s is installed and running\n", result.Version)
	return nil
}

// runInitProbe checks for existing setup and prompts the user.
func runInitProbe(ctx context.Context, probe WorkingDirProbe, workdir string, confirmFn func(string) (bool, error)) (bool, error) {
	state, err := probe.Inspect(workdir)
	if err != nil {
		return false, fmt.Errorf("check working directory: %w", err)
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

// runInitLegacy is an auth-only helper that returns an *Auth with the API key.
// It does NOT save, extract, or render — the orchestrator handles those.
func runInitLegacy(ctx context.Context, cfg Repository, apiKey string, provider string) (*Auth, error) {
	if apiKey == "" {
		key, err := promptAPIKey()
		if err != nil {
			return nil, fmt.Errorf("API key prompt failed: %w", err)
		}
		apiKey = key
	}

	return &Auth{APIKey: apiKey, Provider: provider}, nil
}

// runInitSubmodule configures the pi submodule with the user's fork URL.
func runInitSubmodule(ctx context.Context, cloner Cloner, workdir, forkURL string) error {
	fmt.Fprintf(os.Stderr, "  ℹ Configuring submodules...\n")
	if err := cloner.ConfigureSubmodule(ctx, workdir, "private-pi", forkURL); err != nil {
		return err
	}
	return nil
}

// runInitExtract extracts embedded compose files to the working directory.
func runInitExtract(ctx context.Context, extractor Extractor, workdir string) error {
	fmt.Fprintf(os.Stderr, "  ℹ Extracting compose files...\n")
	if err := extractor.Extract(ctx, workdir); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "  ✓ Compose files extracted to %s/docker\n", workdir)
	return nil
}

// runInitEnv generates docker/.env with host UID/GID and git identity.
func runInitEnv(ctx context.Context, envRenderer EnvRenderer, uidResolver UIDResolver, gitIdentity GitIdentity, workdir string, confirmFn func(string) (bool, error)) error {
	fmt.Fprintf(os.Stderr, "  ℹ Generating docker/.env...\n")

	uid, gid, err := uidResolver.Current()
	if err != nil {
		return fmt.Errorf("resolve user UID/GID: %w", err)
	}

	gitName, gitEmail, err := gitIdentity.Lookup()
	if err != nil {
		// Git identity not found — not fatal, use defaults
		gitName = ""
		gitEmail = ""
	}

	if gitName == "" || gitEmail == "" {
		// Prompt for git identity
		ok, err := confirmFn("No git identity found. Configure git user.name and user.email?")
		if err != nil {
			return err
		}
		if ok {
			promptedName, promptedEmail, err := promptGitIdentity()
			if err != nil {
				return fmt.Errorf("git identity prompt: %w", err)
			}
			if promptedName != "" {
				gitName = promptedName
			}
			if promptedEmail != "" {
				gitEmail = promptedEmail
			}
		} else {
			if gitName == "" {
				gitName = "Cheasee-Pi"
			}
			if gitEmail == "" {
				gitEmail = "cheasee-pi@localhost"
			}
		}
	}

	vals := EnvValues{
		HostUID:  uid,
		HostGID:  gid,
		GitName:  gitName,
		GitEmail: gitEmail,
	}

	envPath := filepath.Join(workdir, "docker", ".env")
	if err := envRenderer.Render(ctx, envPath, vals); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "  ✓ docker/.env generated at %s\n", envPath)
	return nil
}

// promptAPIKey prompts the user for an API key (legacy).
func promptAPIKey() (string, error) {
	var apiKey string
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("API Key").
				Prompt("Enter your API key: ").
				Value(&apiKey),
		),
	)
	err := form.Run()
	return apiKey, err
}

// promptConfirm shows a yes/no confirmation dialog.
func promptConfirm(title string) (bool, error) {
	var confirmed bool
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title(title).
				Value(&confirmed),
		),
	)
	err := form.Run()
	return confirmed, err
}

// promptGitIdentity prompts for git user.name and user.email.
func promptGitIdentity() (name, email string, err error) {
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().Title("Git user.name").Value(&name),
			huh.NewInput().Title("Git user.email").Value(&email),
		),
	)
	err = form.Run()
	return name, email, err
}
