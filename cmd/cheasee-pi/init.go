package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"charm.land/huh/v2"
	"github.com/cli/oauth/device"
	"github.com/spf13/cobra"
)

// nextStepHint is the post-init instruction printed after a successful init run.
// It is a constant so both the CLI and documentation stay in sync.
// If the script path changes, update both init.go and
// docs/installation.md in lockstep.
const nextStepHint = "bash docker/run-pi.sh"

var (
	initAPIKey        string
	initNoDockerCheck bool
	initWorkdir       string
	initSourceRepo    string
	initNoGitHub      bool
	initClientID      string
	initProvider      string
	initSkipFork       bool
	initForkURL        string
	initNoInput        bool
	initSubmoduleURLs  []string
	initSkipSubmodules bool
)

// SourceForkMode controls how the fork source is determined.
type SourceForkMode int

const (
	ModePromptFork  SourceForkMode = iota
	ModeUseForkURL
	ModeSkipFork
)

// SourceForkInput carries the fork source configuration.
type SourceForkInput struct {
	Mode       SourceForkMode
	SourceRepo string
	ForkURL    string
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

	return runInit(
		ctx,
		dockerChecker,
		configRepo,
		initAPIKey,
		initNoDockerCheck,
		initNoGitHub,
		sourceForkInput,
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
		inputFn,
		initNoInput,
		submoduleURLs,
		initSkipSubmodules,
		promptSubmoduleURLs,
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
	sourceForkInput SourceForkInput,
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
	inputFn func(title, placeholder string) (string, error),
	noInput bool,
	submoduleURLs map[string]string,
	skipSubmodules bool,
	promptFn func([]Submodule) (map[string]string, error),
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
		fmt.Fprintf(os.Stderr, "  ℹ Using API-key-only mode.\n")
		fmt.Fprintf(os.Stderr, "  ℹ Provider: %s\n", initProvider)
		auth, err = runInitLegacy(ctx, cfg, apiKey, initProvider)
		if err != nil {
			return err
		}
		auth.RepoPath = workdir
	} else {
		// Phase 3: GitHub OAuth device flow
		token, user, err := runInitAuth(ctx, authenticator)
		if err != nil {
			if errors.Is(err, device.ErrUnsupported) {
				fmt.Fprintf(os.Stderr, "  ⚠ GitHub OAuth device flow unavailable (the configured OAuth app may be invalid).\n")
				fmt.Fprintf(os.Stderr, "  ℹ Falling back to API-key-only mode. Use --client-id to provide your own GitHub OAuth app.\n\n")
				auth, err = runInitLegacy(ctx, cfg, apiKey, initProvider)
				if err != nil {
					return err
				}
				auth.RepoPath = workdir
			} else {
				return fmt.Errorf("GitHub authentication failed: %w", err)
			}
		} else {
			// Phase 4: Get authenticated user identity
			if user == "" {
				u, err := gitHubClient.GetAuthenticatedUser(ctx, token)
				if err != nil {
					return fmt.Errorf("get GitHub user: %w", err)
				}
				user = u
			}

			// Phase 4.5: Prompt for source repo
			resolvedSourceRepo, err := runInitPromptSource(inputFn, sourceForkInput, noInput)
			if err != nil {
				return fmt.Errorf("source repo prompt: %w", err)
			}

			// Determine clone URL and whether to fork
			var cloneURL string
			switch sourceForkInput.Mode {
			case ModeUseForkURL:
				// Use user-supplied fork URL directly — skip fork and wait
				cloneURL = sourceForkInput.ForkURL
				if err := runInitCloneSubmodule(ctx, cloner, token, cloneURL, workdir); err != nil {
					return err
				}

			case ModeSkipFork:
				// Skip fork and clone entirely

			case ModePromptFork:
				// Phase 5: Fork the source repository
				sourceOwner, sourceRepoName := ParseGitHubURL(resolvedSourceRepo)
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
				cloneURL = fmt.Sprintf("https://github.com/%s/%s.git", forkOwner, forkRepo)
				if err := runInitCloneSubmodule(ctx, cloner, token, cloneURL, workdir); err != nil {
					return err
				}
			}

			// Post-clone confirm (skip when noInput is true or fork+clone was skipped)
			if sourceForkInput.Mode != ModeSkipFork && !noInput {
				ok, err := confirmFn(fmt.Sprintf("Forked/Cloned %s to %s. Continue? [Y/n]", cloneURL, workdir))
				if err != nil {
					return err
				}
				if !ok {
					fmt.Fprintln(os.Stderr, "Init cancelled.")
					return nil
				}
			}

			// Configure submodules for non-skip modes
			if sourceForkInput.Mode != ModeSkipFork {
				if err := runInitSubmodule(ctx, cloner, workdir, submoduleURLs, skipSubmodules, promptFn); err != nil {
					return fmt.Errorf("submodule config: %w", err)
				}
			}

			auth = &Auth{
				GitHubToken: token,
				GitHubUser:  user,
				RepoPath:    workdir,
			}
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

// runInitSubmodule orchestrates submodule enumeration, URL prompting, URL overrides,
// and init/update of all submodules.
func runInitSubmodule(
	ctx context.Context,
	cloner Cloner,
	workdir string,
	urlOverrides map[string]string,
	skipAll bool,
	promptFn func([]Submodule) (map[string]string, error),
) error {
	if skipAll {
		fmt.Fprintf(os.Stderr, "  ℹ Skipping submodule setup (--skip-submodules)\n")
		return nil
	}

	fmt.Fprintf(os.Stderr, "  ℹ Configuring submodules...\n")

	submodules, err := cloner.ListSubmodules(ctx, workdir)
	if err != nil {
		return fmt.Errorf("list submodules: %w", err)
	}

	if len(submodules) == 0 {
		fmt.Fprintf(os.Stderr, "  ℹ No submodules found\n")
		return nil
	}

	// Collect URL overrides: prompt first, then CLI flags take precedence
	overrides := make(map[string]string)
	if promptFn != nil {
		promptResult, err := promptFn(submodules)
		if err != nil {
			return fmt.Errorf("prompt for submodule URLs: %w", err)
		}
		for name, url := range promptResult {
			overrides[name] = url
		}
	}
	for name, url := range urlOverrides {
		overrides[name] = url
	}

	// Apply URL changes
	for name, url := range overrides {
		fmt.Fprintf(os.Stderr, "  ℹ Setting submodule %q URL to %s\n", name, url)
		if err := cloner.SetSubmoduleURL(ctx, workdir, name, url); err != nil {
			return fmt.Errorf("set submodule %q URL: %w", name, err)
		}
	}

	// Init and update all submodules
	if err := cloner.InitAndUpdateSubmodules(ctx, workdir); err != nil {
		return fmt.Errorf("update submodules: %w", err)
	}

	fmt.Fprintf(os.Stderr, "  ✓ Submodules configured\n")
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
				Description("Provider: " + initProvider + " (set via --provider)\nGet your key at the provider's dashboard and paste it below.").
				Prompt("Paste your API key: ").
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

// promptInput shows an interactive text input using huh and returns the entered value.
func promptInput(title, placeholder string) (string, error) {
	var value string
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title(title).
				Placeholder(placeholder).
				Value(&value),
		),
	)
	err := form.Run()
	return value, err
}

// runInitPromptSource resolves the source repository to fork from.
// If sourceRepo is empty and noInput is false, prompts interactively.
// Falls back to the default "SchneiderDaniel/cheasee-pi" when input is empty.
func runInitPromptSource(inputFn func(title, placeholder string) (string, error), sfi SourceForkInput, noInput bool) (string, error) {
	switch sfi.Mode {
	case ModeUseForkURL:
		// For fork URL mode, derive source repo from the fork URL
		owner, repo := ParseGitHubURL(sfi.ForkURL)
		if owner != "" && repo != "" {
			return owner + "/" + repo, nil
		}
	case ModeSkipFork:
		// Skip fork entirely — source repo is not used
		if sfi.SourceRepo != "" {
			return sfi.SourceRepo, nil
		}
		return "SchneiderDaniel/cheasee-pi", nil
	}

	if sfi.SourceRepo != "" {
		// User explicitly provided --source-repo
		return sfi.SourceRepo, nil
	}

	if noInput {
		// Non-interactive: use default
		return "SchneiderDaniel/cheasee-pi", nil
	}

	repo, err := inputFn("Which repository would you like to fork?", "SchneiderDaniel/cheasee-pi")
	if err != nil {
		return "", err
	}
	if repo == "" {
		repo = "SchneiderDaniel/cheasee-pi"
	}
	return repo, nil
}

// runInitCloneSubmodule clones a repo and configures its submodule.
func runInitCloneSubmodule(ctx context.Context, cloner Cloner, token, cloneURL, workdir string) error {
	sourceOwner, sourceRepoName := ParseGitHubURL(cloneURL)
	if sourceOwner == "" || sourceRepoName == "" {
		return fmt.Errorf("invalid clone URL: %s", cloneURL)
	}

	if err := cloner.Clone(ctx, token, cloneURL, workdir); err != nil {
		return fmt.Errorf("clone fork: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Cloned %s/%s to %s\n", sourceOwner, sourceRepoName, workdir)
	return nil
}

// parseSubmoduleURLs parses --submodule-url flag values (format: name=url).
func parseSubmoduleURLs(entries []string) (map[string]string, error) {
	result := make(map[string]string, len(entries))
	for _, entry := range entries {
		parts := strings.SplitN(entry, "=", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid --submodule-url format: %q (expected name=url)", entry)
		}
		name := strings.TrimSpace(parts[0])
		url := strings.TrimSpace(parts[1])
		if name == "" {
			return nil, fmt.Errorf("empty submodule name in %q", entry)
		}
		if url == "" {
			return nil, fmt.Errorf("empty URL for submodule %q", name)
		}
		result[name] = url
	}
	return result, nil
}

// promptSubmoduleURLs prompts the user for each submodule's URL.
// Returns a map of name→newURL for entries the user changed.
func promptSubmoduleURLs(submodules []Submodule) (map[string]string, error) {
	type entry struct {
		name       string
		defaultURL string
		url        string
	}

	entries := make([]entry, len(submodules))
	fields := make([]huh.Field, 0, len(submodules))

	for i, sm := range submodules {
		entries[i] = entry{name: sm.Name, defaultURL: sm.URL, url: sm.URL}
		fields = append(fields, huh.NewInput().
			Title(fmt.Sprintf("Submodule %q", sm.Name)).
			Description(fmt.Sprintf("Repository URL [default: %s]", sm.URL)).
			Value(&entries[i].url),
		)
	}

	if len(fields) == 0 {
		return nil, nil
	}

	form := huh.NewForm(huh.NewGroup(fields...))
	if err := form.Run(); err != nil {
		return nil, err
	}

	overrides := make(map[string]string)
	for _, e := range entries {
		if e.url != "" && e.url != e.defaultURL {
			overrides[e.name] = e.url
		}
	}
	return overrides, nil
}
