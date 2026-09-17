package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cli/oauth/device"
	"github.com/spf13/cobra"
)

// newInitDeps builds the shared InitDeps used by both `cheasee-pi init`
// (runInitE) and the empty-folder branch of runUpE, so the two entry points
// run byte-identical flows. Package-var seam (newRepository pattern): tests
// replace it to drive either entry point with stubbed OAuth/prompt boundaries
// instead of a real device flow or TTY.
var newInitDeps = func(workdir string) InitDeps {
	return InitDeps{
		Ports:         InitPorts{Auth: NewAuthenticator(initClientID), Catalog: newModelCatalog()},
		APIKey:        initAPIKey,
		NoDockerCheck: initNoDockerCheck,
		NoGitHub:      initNoGitHub,
		NoInput:       initNoInput,
		Provider:      initProvider,
		ClientID:      initClientID,
		RepoURL:       initRepoURL,
		SkillRepos:    initSkillRepos,
		Workdir:       workdir,
		ConfirmFn:     promptConfirm,
		InputFn:       promptInput,
	}
}

// nextStepHint is the post-init instruction printed after a successful init run.
// It is a constant so both the CLI and documentation stay in sync.
const nextStepHint = "cd <workspace-folder> -> cheasee-pi start"

// initOverview is the pre-prompt narration printed once per interactive
// GitHub-flow init run, before the first prompt. It is a constant so the CLI
// and documentation stay in sync (mirrors nextStepHint). The Docker check has
// already run by the time it prints, so it is folded in retrospectively —
// never promised as a still-pending step.
const initOverview = "🤖 Welcome — one GitHub repo becomes your workspace:\n" +
	"   · nothing touches your existing folders — init runs only in an empty directory\n" +
	"   · the repo is cloned to <parent>/.bare + a worktree; the container mounts that folder\n" +
	"   · then this machine authenticates: GitHub OAuth + LLM API keys\n" +
	"   no repo yet? `--no-github` skips the clone (API-key only). After init: `cheasee-pi start`\n"

// printInitOverview narrates the init workflow to stderr right before the
// first prompt. Mirrors the intro block runInitSkillRepos prints before its
// prompt loop; only interactive GitHub-flow runs reach it.
func printInitOverview() {
	fmt.Fprint(os.Stderr, initOverview)
}

// initTimeout bounds a single init invocation — device-flow OAuth polling
// dominates the window. Shared by `cheasee-pi init` (runInitE) and the
// empty-folder branch of runUpE so both cap the auth window identically
// instead of polling until the ~900 s device-code expiry.
const initTimeout = 5 * time.Minute

var (
	initAPIKey        string
	initNoDockerCheck bool
	initWorkdir       string
	initNoGitHub      bool
	initClientID      string
	initProvider      string
	initNoInput       bool
	initRepoURL       string
	initReauth        bool
	initSkillRepos    []string
)

// InitPorts bundles the injected port interfaces used by runInit.
// Only genuine seams (network/external-service boundaries) keep interfaces;
// docker/git CLI, auth config, and in-process stdlib adapters are package-level
// or called directly by the phase functions.
type InitPorts struct {
	Auth    Authenticator
	Catalog ModelCatalog
}

// InitDeps bundles all dependencies, flags, and callbacks for runInit.
// Provider/ClientID/RepoURL carry the flag-derived init inputs so the
// shared factory (newInitDeps) fully encapsulates them — no package-global
// reads inside the flow (the runUpE empty-folder branch and runInitE run
// identically).
type InitDeps struct {
	Ports            InitPorts
	APIKey           string
	NoDockerCheck    bool
	NoGitHub         bool
	NoInput          bool
	Reauth           bool
	ClientIDExplicit bool
	Provider         string
	ClientID         string
	RepoURL          string
	// SkillRepos are the custom skill repository specs recorded at init into
	// cheasee-settings.json skillRepos (canonical form — the exact string
	// `pi install` accepts, so the entrypoint passes it through without
	// prefix munging) and installed inside the container by the entrypoint via
	// `pi install -l -a` before pi execs.
	SkillRepos []string
	Workdir    string
	ConfirmFn  func(string) (bool, error)
	InputFn    func(title, placeholder string) (string, error)
}

// Validate checks that all required dependencies for the active path are non-nil.
func (d InitDeps) Validate() error {
	var missing []string
	if !d.NoGitHub && d.Ports.Auth == nil {
		missing = append(missing, "Ports.Auth")
	}
	// The provider API-key phase (runInitAPIKeys) consumes the catalog for its
	// model picker — interactive runs must never dereference a nil port.
	if !d.NoInput && d.Ports.Catalog == nil {
		missing = append(missing, "Ports.Catalog")
	}
	if len(missing) > 0 {
		return fmt.Errorf("init: missing required deps: %s", strings.Join(missing, ", "))
	}
	return nil
}

var initCmd = &cobra.Command{
	Use:     "init",
	GroupID: groupIDGettingStarted,
	Short:   "Initialize cheasee-pi configuration",
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
  7. Ask for custom skills (reusable instruction sets for pi) to install
     into the container from git-hosted skill repositories, recorded in
     cheasee-settings.json skillRepos

Existing non-empty folders are intentionally NOT supported — run init in a
fresh empty folder. On an already-initialized workspace (cheasee-settings.json
present), run 'cheasee-pi init --reauth' to redo the authentications: the
GitHub OAuth device flow (updates github_token/github_user) and the pi
provider API-key setup. After init, manage API keys with:
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
	initCmd.Flags().StringVar(&initRepoURL, "repo-url", "", "GitHub repo pi should work on (`owner/repo` or GitHub URL; required with --no-input)")
	initCmd.Flags().BoolVar(&initReauth, "reauth", false, "Redo GitHub and pi API-key authentications on an initialized workspace")
	initCmd.Flags().StringArrayVar(&initSkillRepos, "skill-repo", nil, "Custom skills to install into the container (repeatable; owner/repo, https://…, or git:host/user/repo[@ref])")
}

// runInitE wires up the real dependencies and calls runInit.
func runInitE(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.Background(), initTimeout)
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

	deps := newInitDeps(workdir)
	return runInit(ctx, resolveInitDeps(cmd, workdir, deps))
}

// resolveInitDeps applies the CLI flag wiring to the base deps produced by
// newInitDeps: --reauth → Reauth, explicit --client-id → ClientIDExplicit,
// and — on the re-auth path without an explicit --client-id — the stored
// oauth.clientID from cheasee-settings.json (the app the original token was
// minted under), so the new token stays under the same OAuth app instead of
// orphaning the old token under a different one. Missing/malformed settings
// falls through to the flag/default here; runReauth fails closed on
// malformed settings before any auth change. Separate from runInitE so the
// wiring is testable without executing the flow.
func resolveInitDeps(cmd *cobra.Command, workdir string, deps InitDeps) InitDeps {
	deps.Reauth = initReauth
	deps.ClientIDExplicit = cmd.Flags().Changed("client-id")
	if deps.Reauth && !deps.ClientIDExplicit {
		if settings, err := LoadCheaseeSettings(workdir); err == nil && settings.OAuth.ClientID != "" {
			deps.ClientID = settings.OAuth.ClientID
			deps.Ports.Auth = NewAuthenticator(deps.ClientID)
		}
	}
	return deps
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

	// Phase 2: probe gate — the returned mode selects the phase list. An
	// initialized workspace (cheasee-settings.json present) refuses without
	// --reauth; with --reauth it short-circuits to runReauth (auth redo, no
	// clone, no scaffold). The empty-folder flow is otherwise unchanged.
	mode, probeErr := runInitProbe(deps.Workdir, deps.Reauth)
	if probeErr != nil {
		return probeErr
	}
	if mode == initModeReauth {
		return runReauth(ctx, deps)
	}

	// Phase 2b: workflow overview — the fix for "what is the repo that is
	// mentioned": a ≤5-line stderr preface before the first prompt. Gated on
	// the interactive GitHub path: --no-input never prompts (no interactive
	// narration), --no-github has no clone to explain, and reauth
	// short-circuited above (it must never see clone/workspace copy).
	if !deps.NoInput && !deps.NoGitHub {
		printInitOverview()
	}

	// Phase 3: project repo URL (GitHub path only; legacy --no-github skips
	// the clone entirely). Canonicalized (shorthand/scp → https) before any
	// git call; the canonical form is what the scaffold persists.
	var repoURL string
	if !deps.NoGitHub {
		url, err := resolveRepoURL(deps)
		if err != nil {
			return err
		}
		repoURL, err = canonicalRepoURL(url)
		if err != nil {
			return fmt.Errorf("invalid repo URL %q — expected owner/repo or a GitHub repository URL: %w", url, err)
		}
	}

	// Auth config is file I/O under the OS user config dir — no port.
	cfg := &fileRepository{}

	// Phase 4: Authentication. Credentials are threaded to the phase-7
	// raw-map patch as scalars — either the legacy (provider, apiKey) pair
	// or the GitHub (token, user) pair; usingLegacyAuth picks the patch
	// shape (a typed *Auth round-trip would clobber other providers).
	var (
		legacyProvider, legacyAPIKey string
		ghToken, ghUser              string
		usingLegacyAuth              bool
		err                          error
	)
	if deps.NoGitHub {
		// Legacy path: API key only
		fmt.Fprintf(os.Stderr, "  ℹ Using API-key-only mode.\n")
		fmt.Fprintf(os.Stderr, "  ℹ Provider: %s\n", deps.Provider)
		legacyProvider, legacyAPIKey, err = runInitLegacyAuth(ctx, deps)
		if err != nil {
			return err
		}
		usingLegacyAuth = true
	} else {
		var token, user string
		token, user, err = runInitAuth(ctx, deps.Ports.Auth)
		if err != nil {
			if errors.Is(err, device.ErrUnsupported) {
				fmt.Fprintf(os.Stderr, "  ⚠ GitHub OAuth device flow unavailable (the configured OAuth app may be invalid).\n")
				fmt.Fprintf(os.Stderr, "  ℹ Falling back to API-key-only mode. Use --client-id to provide your own GitHub OAuth app.\n\n")
				legacyProvider, legacyAPIKey, err = runInitLegacyAuth(ctx, deps)
				if err != nil {
					return err
				}
				usingLegacyAuth = true
			} else {
				return fmt.Errorf("GitHub authentication failed: %w", err)
			}
		} else {
			ghToken = token
			ghUser = user
		}
	}

	// Phase 5: clone phase — mkdir + cd for the stated workspace folder name
	// (typically main): the worktree leaf <workdir>/<folderName> becomes the
	// workspace, its sibling .bare the bare clone; everything after (scaffold,
	// skill repos, API keys, failure cleanup) runs inside the leaf as before.
	if !deps.NoGitHub {
		folderName := "main"
		if !deps.NoInput {
			// The input never touches git directly — it only names the folder
			// (the clone checks out the repo's default branch), so the prompt
			// spells that out instead of fabricating a git branch selector.
			fmt.Fprintf(os.Stderr, "   ℹ this name sets the workspace subfolder name only — the repo's default branch is checked out there; it is not a git branch selector\n")
			folderName, err = deps.InputFn("Workspace folder name", "main")
			if err != nil {
				return fmt.Errorf("branch prompt failed: %w", err)
			}
			if folderName = strings.TrimSpace(folderName); folderName == "" {
				folderName = "main"
			}
		}
		// The value only names the worktree folder, so keep it a plain name:
		// a slash would nest folders and break the sibling .bare cleanup.
		if folderName == "." || folderName == ".." || strings.ContainsAny(folderName, `/\\`) {
			return fmt.Errorf("invalid workspace folder name %q — use a plain name like main (no slashes); it names the folder only, not a git branch", folderName)
		}
		deps.Workdir = filepath.Join(deps.Workdir, folderName)
		if err := gitCloneWorktree(ctx, repoURL, deps.Workdir); err != nil {
			return err
		}
	}

	// Phases 6-9 (scaffold → skill repos → save auth → API key setup) run
	// post-clone; a failure here would strand a folder that both init
	// (non-empty probe) and start (WorkspaceRefuse) refuse — the freshly
	// cloned residue (worktree + sibling .bare) is removed before the error
	// surfaces. The empty-folder probe guarantees only freshly cloned +
	// scaffolded files exist, so removal cannot destroy user data.
	postCloneErr := func() error {
		// Phase 6: Scaffold cheasee-settings.json (never overwrites) — the
		// canonical repo URL and resolved GitHub login are threaded in; the
		// legacy --no-github path carries both empty.
		if err := runInitScaffold(ctx, deps, repoURL, ghUser); err != nil {
			return fmt.Errorf("settings scaffold: %w", err)
		}

		// Phase 6b: Custom skill repositories — record-only; the container
		// entrypoint translates the specs to `pi install -l -a` at start.
		if err := runInitSkillRepos(deps); err != nil {
			return fmt.Errorf("skill repo setup: %w", err)
		}

		// Phase 7: Save auth config — merge-safe raw-map patches on the single
		// auth.json format (the typed codec that clobbered other providers is
		// gone). Legacy: provider entry + api_key + repo_path; GitHub:
		// github_token/github_user/repo_path with all providers preserved.
		if usingLegacyAuth {
			if err := cfg.SetLegacyAuth(ctx, legacyProvider, legacyAPIKey, deps.Workdir); err != nil {
				return fmt.Errorf("save auth config: %w", err)
			}
		} else {
			if err := cfg.UpdateGitHubAuth(ctx, ghToken, ghUser, deps.Workdir); err != nil {
				return fmt.Errorf("save auth config: %w", err)
			}
		}

		path, _ := cfg.Path()
		fmt.Fprintf(os.Stderr, "  ✓ Auth config saved to %s\n", path)

		// Phase 8: API key setup for pi providers (interactive only)
		if !deps.NoInput {
			if err := runInitAPIKeys(ctx, cfg, deps.Ports.Catalog, deps.Workdir, deps.ConfirmFn); err != nil {
				return fmt.Errorf("API key setup: %w", err)
			}
		}
		return nil
	}()
	if postCloneErr != nil {
		removeInitResidue(deps.Workdir)
		return postCloneErr
	}

	// Init never launches pi — init sets the workspace up and hands off to
	// `cheasee-pi start` (the runUpE empty-folder branch returns after init;
	// a second invocation then starts the container).
	fmt.Fprintf(os.Stderr, "\n✅ Init complete! Next step:\n")
	fmt.Fprintf(os.Stderr, "   %s\n", nextStepHint)
	return nil
}

// initMode selects the runInit phase list after the probe gate.
type initMode int

const (
	// initModeFull is the empty-folder init flow: repo URL, OAuth, clone,
	// scaffold, auth save, API-key setup.
	initModeFull initMode = iota
	// initModeReauth re-runs only the authentication phases on an
	// initialized workspace (cheasee-settings.json present + --reauth).
	initModeReauth
)

// runInitProbe enforces the init contract and selects the mode: refuses when
// cheasee-settings.json already exists (presence = initialized marker) unless
// reauth is set (→ initModeReauth; the empty-folder probe is skipped — an
// initialized workspace has files by design), and refuses non-empty folders
// for the full flow (cheasee-pi never auto-initializes existing folders).
// Workspace facts (marker + empty probe + .DS_Store tolerance) come from
// workspaceFacts; this mapping just applies the init policy to them.
// Returns initModeFull to proceed with the full flow.
func runInitProbe(workdir string, reauth bool) (initMode, error) {
	settingsPresent, empty, firstEntry, err := workspaceFacts(workdir)
	if err != nil {
		return initModeFull, fmt.Errorf("inspect folder: %w", err)
	}
	if settingsPresent {
		if reauth {
			return initModeReauth, nil
		}
		return initModeFull, fmt.Errorf("already initialized: %s exists — run `cheasee-pi start`, or `cheasee-pi init --reauth` to redo the GitHub and pi API-key authentications", cheaseeSettingsPath(workdir))
	}
	if !empty {
		return initModeFull, fmt.Errorf("init requires an empty folder: %q is not empty (found %q) — cheasee-pi init sets the workspace up itself (bare clone + worktree) and never initializes existing folders", workdir, firstEntry)
	}
	return initModeFull, nil
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
	// Hint is narration on stderr before the prompt (the InputFn seam carries
	// only title+placeholder; the hint and the placeholder carry different
	// information — no full-URL duplication).
	fmt.Fprintf(os.Stderr, "   ℹ the repo must already exist on GitHub — cheasee-pi clones it to\n")
	fmt.Fprintf(os.Stderr, "     <parent>/.bare + a worktree, and the container mounts this folder\n")
	url, err := deps.InputFn("GitHub repo pi should work on", "owner/repo")
	if err != nil {
		return "", fmt.Errorf("repo URL prompt failed: %w", err)
	}
	url = strings.TrimSpace(url)
	if url == "" {
		return "", errors.New("empty repo URL — expected owner/repo or a GitHub repository URL")
	}
	return url, nil
}
