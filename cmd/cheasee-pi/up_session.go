package main

import (
	"context"
	"fmt"
	"os"
)

// startOptions is one `cheasee-pi start` invocation as parsed by the cobra
// adapter: a plain value, so the use case can be driven directly (and so a run
// never reads or writes a package global).
type startOptions struct {
	Name          string // --name; empty derives the repo-slug default
	Workdir       string // --workdir; empty means the current directory
	Build         bool   // --build
	NoDockerCheck bool   // --no-docker-check
	DryRun        bool   // --dry-run
}

// resolveName is the container name for this run: --name verbatim, otherwise
// the repo-slug default derived from the workspace root.
func (o startOptions) resolveName(root string) string {
	if o.Name != "" {
		return o.Name
	}
	return containerName(root)
}

// startSession is the start use case: workspace gate, docker check, env
// assembly, stack bring-up, sidecar URL publication, live-session claim, and
// finally the pi exec plus session reap. Every docker, port and exec call
// leaves through a package-level seam, so the whole flow is testable without a
// daemon; the phases themselves live in up_session_stages.go and
// up_session_launch.go.
func startSession(ctx context.Context, opts startOptions) error {
	workdir, err := resolveWorkdir(opts.Workdir)
	if err != nil {
		return fmt.Errorf("resolve workdir: %w", err)
	}

	// Phase 1: workspace gate — empty folder → auto-init and stop;
	// cheasee-settings.json present → run; anything else → refuse. Runs before
	// any docker/git call so a non-initialized cwd is refused fast (and dry-run
	// touches nothing).
	root, stop, err := startWorkspaceGate(ctx, workdir, opts.DryRun)
	if err != nil || stop {
		return err
	}

	// The container name carries the repo slug (cheasee-pi-<repo>) so multiple
	// workspaces run side by side without daemon name collisions; an explicit
	// --name overrides the derived default verbatim.
	name := opts.resolveName(root)
	// docker exec working directory: /workspaces/main when started at the
	// workspace root, /workspaces/main/<rel> from a subdirectory.
	target := execTarget(workdir)

	// Phase 2: Docker check
	if !opts.NoDockerCheck {
		if err := runInitDockerCheck(ctx); err != nil {
			return err
		}
	}

	// Phase 3: env from auth.json + gh token + --api-key, plus the run markers.
	env, err := startEnv(ctx, root)
	if err != nil {
		return err
	}
	warnMissingProviderKeys(env)

	// Phase 4: dry-run — print env vars + the docker command, then exit.
	if dryRunStop(opts, env, name, target) {
		return nil
	}

	// Phase 4b: reconcile the persistent workspace before the container starts.
	// The mount survives image rebuilds, so a workspace from an older release
	// still registers a package this one no longer ships — plus the entrypoint
	// reinstalls every skillRepos spec on start, which is why the cleanup belongs
	// here, ahead of ensureContainerReady. A live session holds the workspace: the
	// refusal aborts the start.
	if err := retireStage(root); err != nil {
		return err
	}

	// Phase 5-6: extract the version-keyed compose cache, start the stack
	// (existing containers as they are, missing ones created, absent images
	// built only with --build) and wait for the entrypoint ready marker before
	// execing pi (see ensureContainerReady).
	//
	// The discovery snapshot is materialised first — the ui service bind-mounts
	// that FILE, and docker would create a directory at a missing source (see
	// up_session_discovery.go).
	materializeInstanceSnapshot(ctx)
	if _, err := ensureContainerReady(ctx, root, name, opts.Build); err != nil {
		return err
	}
	publishResolvedPorts(ctx, root, env)

	// Phase 6a: register this instance so peer sidecars (and this one) can list
	// and link it.
	registerInstanceWithWarning(ctx, root)

	// One-line cheatsheet so a fresh session has the in-pi help and the
	// stop/cleanup commands in front of it the moment pi launches.
	fmt.Fprintf(os.Stderr, "  ℹ inside pi: /help · exit session: Ctrl+D · stop container: cheasee-pi down · full cleanup: cheasee-pi clean\n")

	// Phase 6b: publish the live-session claim on the shared workspace mount so
	// the ui sidecar's cross-container in-use guard can refuse a second attach.
	release := claimLiveSession(root, name, env.sessionID())
	defer release()

	// Phase 7: pre-start orphan scan + container /tmp reclaim.
	if err := prepareLaunch(ctx, name); err != nil {
		return err
	}

	// Phase 8: exec pi, then reap the session by marker.
	return execPiSession(ctx, name, env.Map(), target, env.sessionID())
}
