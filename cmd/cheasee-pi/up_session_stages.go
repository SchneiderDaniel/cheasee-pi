package main

import (
	"context"
	"fmt"
	"maps"
	"os"
	"slices"
	"strings"
)

// startWorkspaceGate classifies the workdir and, for an empty folder, runs the
// one-shot init and reports stop=true: init never launches pi, so the next
// invocation starts. A folder that is neither empty nor initialized is
// refused — cheasee-pi never auto-initializes existing folders.
func startWorkspaceGate(ctx context.Context, workdir string,
	dryRun bool) (root string, stop bool, err error) {
	root, state, err := resolveStartWorkspace(workdir)
	if err != nil {
		return "", false, err
	}
	switch state {
	case WorkspaceEmpty:
		if dryRun {
			fmt.Fprintf(os.Stderr, "  ℹ %s is empty — would run `cheasee-pi init` (bare clone + main worktree + cheasee-settings.json), then stop. Run `cheasee-pi start` again to launch pi.\n", workdir)
			return "", true, nil
		}
		fmt.Fprintf(os.Stderr, "  ℹ %s is empty — running `cheasee-pi init`...\n", workdir)
		// Init is time-bounded (device-flow OAuth polling dominates the window).
		initCtx, cancel := context.WithTimeout(ctx, initTimeout)
		initErr := runInit(initCtx, newInitDeps(workdir))
		cancel()
		if initErr != nil {
			return "", true, fmt.Errorf("cheasee-pi detected an empty folder and tried to initialize it, but %w", initErr)
		}
		// Init never launches pi: stop here and let the next invocation start.
		// If init left the folder non-empty without a settings marker, the next
		// `cheasee-pi start` refuses via WorkspaceRefuse (fail-closed).
		return "", true, nil
	case WorkspaceRefuse:
		return "", true, fmt.Errorf("not initialized: %q is not empty and has no cheasee-settings.json — run `cheasee-pi init` in an empty folder first", workdir)
	}
	return root, false, nil
}

// startEnv assembles the run's env: the provider keys from auth.json/env (see
// buildEnvFlags) plus the run's own markers.
func startEnv(ctx context.Context, root string) (*sessionEnv, error) {
	base, err := buildEnvFlags(ctx)
	if err != nil {
		return nil, fmt.Errorf("build env vars: %w", err)
	}
	env := newSessionEnv(base)

	// Forward the resolved CodeFlow host port into the exec env (buildEnvFlags
	// passthroughs only provider keys + GH_TOKEN/CLOUDFLARE_ACCOUNT_ID), so the
	// in-container context-info extension can print the exact bound URL instead
	// of re-deriving (its derive-only copy matches except in probe-shift cases).
	// Resolution failure is already surfaced by the post-up print and by
	// applyComposeEnv; the key stays absent and the extension falls back to its
	// own derivation.
	if port, err := codeflowHostPort(root); err == nil {
		env.setCodeflowPort(port)
	}

	// Tag this session so the reaper can find it after the docker exec client
	// detaches. Disconnected exec sessions stay alive (their parent remains the
	// host-side shim, so the orphan scan never sees them); killing by this
	// unique marker is the only way to reap exactly the session we launched.
	env.setSessionID(newSessionID())
	return env, nil
}

// retireStage is the pre-container migration stage: reconcile the persistent
// workspace with the packages this release still ships. It reports what it
// changed on stderr — a converged workspace stays silent — and surfaces every
// failure, because a workspace the migration could not clean would keep loading
// the retired package for the whole session.
func retireStage(root string) error {
	rep, err := retirePackages(root, retireOptions{})
	if err != nil {
		return fmt.Errorf("retire removed packages: %w", err)
	}
	printRetireReport(rep, false)
	return nil
}

// warnMissingProviderKeys surfaces the start warning for an env with no provider
// key: pi stays usable, but models may not be available.
func warnMissingProviderKeys(env *sessionEnv) {
	if len(env.Map()) > 0 {
		return
	}
	fmt.Fprintf(os.Stderr, "  ⚠ No provider keys found. Models may not be available.\n")
	fmt.Fprintf(os.Stderr, "  ℹ Use: cheasee-pi auth add <provider>\n")
}

// dryRunStop prints the dry-run output and reports whether the run must stop:
// a dry-run touches nothing past this point (no scaffold, no cache extraction,
// no compose, no exec).
func dryRunStop(opts startOptions, env *sessionEnv, name, target string) bool {
	if !opts.DryRun {
		return false
	}
	printEnvAndCommand(env.Map(), name, target)
	return true
}

// printEnvAndCommand is the dry-run output: the env vars to inject (secrets
// redacted) and the exact docker command.
func printEnvAndCommand(env map[string]string, name, target string) {
	fmt.Fprintf(os.Stderr, "Env vars to be injected:\n")
	for _, key := range slices.Sorted(maps.Keys(env)) {
		fmt.Fprintf(os.Stderr, "  %s=%s\n", key, redactSecret(env[key]))
	}
	// Show full docker command for debugging
	args := execArgs(env, name, target)
	fmt.Fprintf(os.Stderr, "\nDocker command:\n  docker %s\n", strings.Join(args, " "))
}
