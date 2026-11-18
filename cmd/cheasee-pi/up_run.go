package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

// runUpE is the cobra adapter: read the parsed flags, hand the use case a
// value, and surface its error. Every docker, port and exec call — and every
// choice about them — lives in startSession, so the command layer stays humble.
func runUpE(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	return startSession(ctx, startOptionsFromFlags(cmd))
}

// startOptionsFromFlags turns the parsed cobra flags into the use-case input.
// Only a flag that was actually set overrides a default: --name is the sole
// value a run may not derive, and reading it through Changed keeps an unset
// flag from pinning a stale package global into the run.
func startOptionsFromFlags(cmd *cobra.Command) startOptions {
	opts := startOptions{
		Workdir:       upWorkdir,
		Build:         upBuild,
		NoDockerCheck: upNoDockerCheck,
		DryRun:        upDryRun,
	}
	if cmd.Flags().Changed("name") {
		opts.Name = upName
	}
	return opts
}

// publishResolvedPorts prints the sidecar hints and forwards both resolved host
// ports into the exec env.
func publishResolvedPorts(ctx context.Context, root string, env *sessionEnv) {
	// CodeFlow URL: the port the sidecar actually published (`docker port`),
	// authoritative when the container already runs — codeflowHostPort's probe
	// sees that live bind as occupancy and shifts to the next free port,
	// printing a URL that points at nothing. Falls back to derive+probe on any
	// docker error (first up, stopped sidecar). The env carries the same
	// resolved port so the in-container context-info echo stays in sync.
	if port, err := codeflowBoundPort(ctx, root); err == nil {
		env.setCodeflowPort(port)
		printCodeFlowHint(port)
	} else if port, err := codeflowHostPort(root); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ CodeFlow port: %v\n", err)
	} else {
		env.setCodeflowPort(port)
		printCodeFlowHint(port)
	}

	// UI URL: bound-first single resolution (resolveUIHostPort) so the printed
	// hint, the compose env, and the in-session footer link all carry the same
	// port. `docker port` is authoritative when the container already runs —
	// uiHostPort's probe sees that live bind as occupancy and shifts to the
	// next free port, printing a URL that points at nothing. Falls back to
	// derive+probe on any docker error (first up, stopped sidecar). The
	// resolved host port is forwarded as PI_UI_PORT (host namespace, NOT the
	// sidecar's container port 3000) for the in-container context-info footer
	// link.
	//
	// On resolution failure PI_UI_PORT is OMITTED — never forwarded empty, which
	// would put a bare `PI_UI_PORT=` in the docker exec env and claim a port that
	// is not there (R1 AC3). The failure travels on its own marker key instead:
	// the extension reads CHEASEE_UI_PORT_UNRESOLVED=1 to suppress its UI link,
	// while an absent PI_UI_PORT WITHOUT the marker (no CLI ran) still derives.
	// Start succeeds either way (best-effort, like the CodeFlow forwarding).
	if port, err := resolveUIHostPort(ctx, root); err == nil {
		env.setUIPort(port)
		printUIHint(port)
	} else {
		env.markUIUnresolved()
		fmt.Fprintf(os.Stderr, "  ⚠ UI port: %v\n", err)
	}
}

// ensureContainerReady extracts the version-keyed compose cache, starts the
// stack (reusing existing containers unless --build asks for a rebuild) and
// waits for the entrypoint ready marker.
func ensureContainerReady(ctx context.Context, root, name string, build bool) (cacheDir string, err error) {
	// Credential gate FIRST (fail closed): Compose builds the auth.json secret
	// mount with CreateMountpoint:false, so an absent host file surfaces as an
	// opaque bind error at container start, after a ~1GB image build. Runs
	// after the auto-init phase, which is what writes auth.json on a fresh
	// machine — so a workspace init just created can start immediately.
	authPath, err := (&fileRepository{}).Path()
	if err != nil {
		return "", fmt.Errorf("resolve credential file: %w", err)
	}
	if err := ensureAuthFile(authPath); err != nil {
		return "", err
	}
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
	if build {
		// Explicit rebuild: build every service, then up every service — the
		// one path allowed to recreate containers and refresh images.
		//
		// True first-build gate: the ~1GB download notice belongs only to an
		// actual first build — keyed on image absence (docker image inspect
		// exit code), never on !running alone, or every cached cold start
		// nags. Fail-closed: inspect before compose — a daemon error here is
		// real (the Phase-2 docker check already passed), never "missing".
		exists, err := imageExists(ctx, cheaseeImageRef(root))
		if err != nil {
			return "", fmt.Errorf("check image: %w", err)
		}
		if err := dockerComposeUp(ctx, cacheDir, root, name, !exists); err != nil {
			return "", fmt.Errorf("docker compose up: %w", err)
		}
	} else {
		// Normal start reuses what exists: existing containers are started
		// as-is (never rebuilt, pulled or recreated), and only missing
		// containers/images are created/built (see ensureStackUp).
		if err := ensureStackUp(ctx, cacheDir, root, name); err != nil {
			return "", err
		}
		// A sidecar container that already existed is only started, never
		// recreated, so it can still be stale relative to this CLI's compose/
		// config/port: compare the live container against the freshly
		// extracted expected state and warn with the exact recovery command
		// (best-effort, never a start failure). Runs after the reconcile so a
		// sidecar it just created is already matching.
		if running {
			warnIfCodeflowDrift(ctx, root, cacheDir)
			// Same read-only inspect shape, different container: the credential
			// stamp says whether this container was created from the auth.json
			// currently on the host. Warn only — a surprise recreate would break
			// the zero-compose contract and interrupt a live session.
			warnIfAuthDrift(ctx, root)
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
