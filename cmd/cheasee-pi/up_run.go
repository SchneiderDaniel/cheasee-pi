package main

import (
	"context"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/spf13/cobra"
)

func runUpE(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}

	workdir, err := resolveWorkdir(upWorkdir)
	if err != nil {
		return fmt.Errorf("resolve workdir: %w", err)
	}

	// Phase 1: workspace gate — empty folder → auto-init and stop; cheasee-settings.json
	// present → run; anything else → refuse. Runs before any docker/git call so
	// a non-initialized cwd is refused fast (and dry-run touches nothing).
	root, state, err := resolveStartWorkspace(workdir)
	if err != nil {
		return err
	}
	if state == WorkspaceEmpty {
		if upDryRun {
			fmt.Fprintf(os.Stderr, "  ℹ %s is empty — would run `cheasee-pi init` (bare clone + main worktree + cheasee-settings.json), then stop. Run `cheasee-pi start` again to launch pi.\n", workdir)
			return nil
		}
		fmt.Fprintf(os.Stderr, "  ℹ %s is empty — running `cheasee-pi init`...\n", workdir)
		// Init is time-bounded (device-flow OAuth polling dominates the window).
		initCtx, cancel := context.WithTimeout(ctx, initTimeout)
		initErr := runInit(initCtx, newInitDeps(workdir))
		cancel()
		if initErr != nil {
			return fmt.Errorf("cheasee-pi detected an empty folder and tried to initialize it, but %w", initErr)
		}
		// Init never launches pi: stop here and let the next invocation start.
		// If init left the folder non-empty without a settings marker, the next
		// `cheasee-pi start` refuses via WorkspaceRefuse (fail-closed).
		return nil
	}
	if state == WorkspaceRefuse {
		return fmt.Errorf("not initialized: %q is not empty and has no cheasee-settings.json — run `cheasee-pi init` in an empty folder first", workdir)
	}

	// Container name carries the repo slug (cheasee-pi-<repo>) so multiple
	// workspaces run side by side without daemon name collisions; an explicit
	// --name overrides the derived default verbatim.
	if !cmd.Flags().Changed("name") {
		upName = containerName(root)
	}

	// docker exec working directory: /workspaces/main when started at the
	// workspace root, /workspaces/main/<rel> when started from a subdirectory.
	// Best-effort --show-prefix: a broken/corrupt worktree falls back to the
	// root instead of refusing (the settings gate already passed).
	target := "/workspaces/main"
	if _, relCwd, err := repoRoot(workdir); err == nil && relCwd != "" && relCwd != "." {
		target += "/" + relCwd
	}

	// Phase 2: Docker check
	if !upNoDockerCheck {
		if err := runInitDockerCheck(ctx); err != nil {
			return err
		}
	}

	// Phase 3: Build env map from auth.json + gh token + --api-key
	envMap, err := buildEnvFlags(ctx)
	if err != nil {
		return fmt.Errorf("build env vars: %w", err)
	}

	// Forward the resolved CodeFlow host port into the exec env (buildEnvFlags
	// passthroughs only provider keys + GH_TOKEN/CLOUDFLARE_ACCOUNT_ID), so the
	// in-container context-info extension can print the exact bound URL instead
	// of re-deriving (its derive-only copy matches except in probe-shift cases).
	// Resolution failure is already surfaced by the post-up print below and by
	// applyComposeEnv; the key stays absent and the extension falls back to its
	// own derivation.
	if port, err := codeflowHostPort(root); err == nil {
		envMap["CODEFLOW_PORT"] = port
	}

	// Tag this session so the reaper can find it after the docker exec client
	// detaches. Disconnected exec sessions stay alive (their parent remains the
	// host-side shim, so the orphan scan never sees them); killing by this
	// unique marker is the only way to reap exactly the session we launched.
	sessionID := newSessionID()
	envMap["CHEASEE_SESSION_ID"] = sessionID

	if len(envMap) == 0 {
		fmt.Fprintf(os.Stderr, "  ⚠ No provider keys found. Models may not be available.\n")
		fmt.Fprintf(os.Stderr, "  ℹ Use: cheasee-pi auth add <provider>\n")
	}

	// Phase 4: dry-run — print env vars + the docker command, then exit.
	// Touches nothing: no scaffold, no cache extraction, no compose, no exec
	// (a dry-run on a fresh machine must not kick off a 10-minute image build).
	if upDryRun {
		fmt.Fprintf(os.Stderr, "Env vars to be injected:\n")
		for _, envVar := range slices.Sorted(maps.Keys(envMap)) {
			fmt.Fprintf(os.Stderr, "  %s=%s\n", envVar, redactEnvValue(envMap[envVar]))
		}
		// Show full docker command for debugging
		args := execArgs(envMap, upName, target)
		fmt.Fprintf(os.Stderr, "\nDocker command:\n  docker %s\n", strings.Join(args, " "))
		return nil
	}

	// Phases 5-6: extract the version-keyed compose cache, start the container
	// when missing or --build, and wait for the entrypoint ready marker before
	// execing pi (see ensureContainerReady).
	if _, err := ensureContainerReady(ctx, root, upName, upBuild); err != nil {
		return err
	}

	// CodeFlow URL: the port the sidecar actually published (`docker port`),
	// authoritative when the container already runs — codeflowHostPort's probe
	// sees that live bind as occupancy and shifts to the next free port,
	// printing a URL that points at nothing. Falls back to derive+probe on any
	// docker error (first up, stopped sidecar). envMap carries the same
	// resolved port so the in-container context-info echo stays in sync.
	if port, err := codeflowBoundPort(ctx, root); err == nil {
		envMap["CODEFLOW_PORT"] = port
		printCodeFlowHint(port)
	} else if port, err := codeflowHostPort(root); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ CodeFlow port: %v\n", err)
	} else {
		envMap["CODEFLOW_PORT"] = port
		printCodeFlowHint(port)
	}

	// Phase 7: Run pre-start orphan scan (best-effort; PPid=1 orphans only —
	// age reaping is clean's job, a pre-start age sweep could kill a long-
	// running session the user still has attached elsewhere)
	killed, err := scanOrphans(ctx, upName, 0, false)
	if err != nil {
		return fmt.Errorf("pre-start orphan scan: %w", err)
	}
	if len(killed) > 0 {
		fmt.Fprintf(os.Stderr, "  ✓ Killed %d orphaned pi process(es)\n", len(killed))
	}

	// Phase 8: exec pi.
	execErr := execPIContainer(upName, envMap, target)

	// The docker exec client just exited (user quit or disconnected). Reap the
	// session by marker: on disconnect pi keeps running with PPid=0, invisible
	// to the orphan scan — without this every detached start leaks a pi.
	if err := killSessionByMarker(ctx, upName, sessionID); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ session reaper: %v\n", err)
	}
	return execErr
}

// ensureContainerReady extracts the version-keyed compose cache, starts the
// container when missing or --build, and waits for the entrypoint ready marker.
func ensureContainerReady(ctx context.Context, root, name string, build bool) (cacheDir string, err error) {
	cacheDir, err = ensureCacheDir(ctx)
	if err != nil {
		return "", fmt.Errorf("cache dir: %w", err)
	}
	if err := NewExtractor().Extract(ctx, cacheDir); err != nil {
		return "", fmt.Errorf("extract compose files: %w", err)
	}
	running, err := containerRunning(ctx, name)
	if err != nil {
		return "", fmt.Errorf("check container: %w", err)
	}
	if build || !running {
		if err := dockerComposeUp(ctx, cacheDir, root, name); err != nil {
			return "", fmt.Errorf("docker compose up: %w", err)
		}
	}
	// Gate the exec behind first-run setup: compose up -d returns as soon as
	// the container starts, long before the entrypoint finishes (worktree
	// fix, ownership, workspace npm install). The healthcheck only passes
	// once the entrypoint wrote its ready marker, so a fresh container
	// starts pi with all deps in place.
	if err := waitHealthy(ctx, name); err != nil {
		return "", err
	}
	return cacheDir, nil
}

// WorkspaceState is the start-gate classification of a folder.
type WorkspaceState int

const (
	WorkspaceEmpty       WorkspaceState = iota // empty (or .DS_Store-only) → auto-init
	WorkspaceInitialized                       // cheasee-settings.json present → run
	WorkspaceRefuse                            // non-empty, no settings → refuse
)

// resolveStartWorkspace resolves the start gate: walks up from workdir
// looking for cheasee-settings.json — the initialized marker — and returns
// the workspace root (the folder cheasee-pi set up) with state
// WorkspaceInitialized. When no ancestor is initialized, classifyWorkspace
// classifies the cwd itself (empty → auto-init, else refuse).
//
// Falls back to resolveWorkspaceParent when workdir sits outside the
// worktree but IS the cheasee-pi parent folder (the folder init ran in) —
// the workspace leaf is then the child holding the settings marker, so
// `cheasee-pi start`/`down` work from the parent without a cd.
//
// Fail-closed on stat errors: a permission-denied ancestor (EACCES) is a
// hard error, never a silent "keep walking" — walking past an unreadable
// ancestor would redirect the project target to the wrong folder.
func resolveStartWorkspace(workdir string) (root string, state WorkspaceState, err error) {
	dir, err := filepath.Abs(workdir)
	if err != nil {
		dir = workdir
	}
	for {
		if _, err := os.Stat(cheaseeSettingsPath(dir)); err == nil {
			return dir, WorkspaceInitialized, nil
		} else if !os.IsNotExist(err) {
			return "", 0, fmt.Errorf("check workspace marker %q: %w", cheaseeSettingsPath(dir), err)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break // filesystem root — parent-layout fallback, then cwd classification
		}
		dir = parent
	}
	if root, ok := resolveWorkspaceParent(workdir); ok {
		return root, WorkspaceInitialized, nil
	}
	state, err = classifyWorkspace(workdir)
	return "", state, err
}

// classifyWorkspace classifies a folder for the start gate: an empty folder
// is ready for auto-init, a folder with cheasee-settings.json is an
// initialized workspace, and anything else is refused — cheasee-pi never
// auto-initializes existing folders. Workspace facts (marker + empty probe +
// .DS_Store tolerance) come from workspaceFacts; this mapping just applies
// the WorkspaceState policy to them.
func classifyWorkspace(workdir string) (WorkspaceState, error) {
	settingsPresent, empty, _, err := workspaceFacts(workdir)
	if err != nil {
		return 0, fmt.Errorf("inspect workspace %q: %w", workdir, err)
	}
	if settingsPresent {
		return WorkspaceInitialized, nil
	}
	if !empty {
		return WorkspaceRefuse, nil
	}
	return WorkspaceEmpty, nil
}
