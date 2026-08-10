package main

import (
	"context"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

var (
	upName          string
	upWorkdir       string
	upBuild         bool
	upNoDockerCheck bool
	upAPIKey        string
	upDryRun        bool
)

var upCmd = &cobra.Command{
	Use:     "start",
	Aliases: []string{"up"},
	Short:   "Launch pi inside container with provider keys injected",
	Long: `Launch an interactive pi session inside the Cheasee-Pi Docker container.

Runs from a cheasee-pi workspace: the workspace folder (main worktree) is
bind-mounted at /workspaces/main and its sibling bare repo at
/workspaces/.bare inside the container. compose/Dockerfile live in a
CLI-managed cache dir; the dedicated cheasee-settings.json (gitignored,
machine-local) is the initialized marker.

Empty folder → runs cheasee-pi init first (bare clone + main worktree +
cheasee-settings.json). Non-empty folder without cheasee-settings.json is
refused — run 'cheasee-pi init' in an empty folder.

The image clones the cheasee-pi repo at build time (Dockerfile ARG
CHEASEE_REF) for its .pi resources. Reads provider API keys from
~/.config/cheasee-pi/auth.json and passes them as environment variables to
 the container, so pi finds models without manual /login.

If the container is not running, starts it with docker compose up first.
Use --build to force rebuild.

Examples:
  cheasee-pi start               # start pi with keys from auth.json
  cheasee-pi start --build       # rebuild, then start pi
  cheasee-pi start --api-key ..  # temporary key for this session`,
	DisableAutoGenTag: true,
	RunE:              runUpE,
}

func init() {
	rootCmd.AddCommand(upCmd)
	upCmd.Flags().StringVar(&upName, "name", "cheasee-pi", "Container name")
	upCmd.Flags().StringVar(&upWorkdir, "workdir", "", "Working directory (default: current directory)")
	upCmd.Flags().BoolVar(&upBuild, "build", false, "Rebuild container image before starting")
	upCmd.Flags().BoolVar(&upNoDockerCheck, "no-docker-check", false, "Skip Docker Engine check")
	upCmd.Flags().StringVar(&upAPIKey, "api-key", "", "Provider API key for this session (not saved)")
	upCmd.Flags().BoolVar(&upDryRun, "dry-run", false, "Print env vars that would be passed, then exit")
}

// newRepository is the auth config constructor, overridable in tests.
var newRepository = func() *fileRepository {
	return &fileRepository{}
}

func runUpE(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}

	workdir, err := resolveWorkdir(upWorkdir)
	if err != nil {
		return fmt.Errorf("resolve workdir: %w", err)
	}

	// Phase 1: workspace gate — empty folder → auto-init; cheasee-settings.json
	// present → run; anything else → refuse. Runs before any docker/git call so
	// a non-initialized cwd is refused fast (and dry-run touches nothing).
	root, state, err := resolveStartWorkspace(workdir)
	if err != nil {
		return err
	}
	if state == WorkspaceEmpty {
		if upDryRun {
			fmt.Fprintf(os.Stderr, "  ℹ %s is empty — would run `cheasee-pi init` (bare clone + main worktree + cheasee-settings.json), then `cheasee-pi start` again.\n", workdir)
			return nil
		}
		fmt.Fprintf(os.Stderr, "  ℹ %s is empty — running `cheasee-pi init` first...\n", workdir)
		if err := runInit(ctx, newInitDeps(workdir)); err != nil {
			return fmt.Errorf("auto-init failed: %w", err)
		}
		fmt.Fprintf(os.Stderr, "  ℹ Init complete — run `cheasee-pi start` again to launch pi.\n")
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

	// Phase 5: ensure the version-keyed cache dir with embedded compose
	// assets (regenerable; a fresh extraction overwrites cleanly).
	cacheDir, err := ensureCacheDir(ctx)
	if err != nil {
		return fmt.Errorf("cache dir: %w", err)
	}
	if err := NewExtractor().Extract(ctx, cacheDir); err != nil {
		return fmt.Errorf("extract compose files: %w", err)
	}

	// Phase 6: Ensure container running
	running, err := containerRunning(upName)
	if err != nil {
		return fmt.Errorf("check container: %w", err)
	}

	if upBuild || !running {
		if err := dockerComposeUp(ctx, cacheDir, root, upName); err != nil {
			return fmt.Errorf("docker compose up: %w", err)
		}
	}

	// Gate the exec behind first-run setup: compose up -d returns as soon as
	// the container starts, long before the entrypoint finishes (worktree
	// fix, ownership, workspace npm install). The healthcheck only passes
	// once the entrypoint wrote its ready marker, so a fresh container
	// starts pi with all deps in place.
	if err := waitHealthy(ctx, upName); err != nil {
		return err
	}

	// Phase 7: Run pre-start orphan scan (best-effort)
	killed, err := scanOrphans(ctx, upName)
	if err != nil {
		return fmt.Errorf("pre-start orphan scan: %w", err)
	}
	if killed > 0 {
		fmt.Fprintf(os.Stderr, "  ✓ Killed %d orphaned pi process(es)\n", killed)
	}

	// Phase 8: exec pi
	return execPIContainer(upName, envMap, target)
}

// WorkspaceState is the start-gate classification of a folder.
type WorkspaceState int

const (
	WorkspaceEmpty       WorkspaceState = iota // empty (or .DS_Store-only) → auto-init
	WorkspaceInitialized                       // cheasee-settings.json present → run
	WorkspaceRefuse                            // non-empty, no settings → refuse
)

// resolveStartWorkspace resolves the start gate in a single pass: walks up
// from workdir looking for cheasee-settings.json (the initialized marker) and
// returns the workspace root when an ancestor is initialized; when no ancestor
// is, classifies the cwd itself (empty → auto-init, else refuse). One stat
// per ancestor level — no second pass over the cwd.
func resolveStartWorkspace(workdir string) (root string, state WorkspaceState, err error) {
	dir, err := filepath.Abs(workdir)
	if err != nil {
		dir = workdir
	}
	for {
		if _, err := os.Stat(cheaseeSettingsPath(dir)); err == nil {
			return dir, WorkspaceInitialized, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			state, err := classifyWorkspace(workdir)
			return "", state, err
		}
		dir = parent
	}
}

// classifyWorkspace classifies a folder for the start gate: an empty folder
// (or one containing only .DS_Store) is ready for auto-init, a folder with
// cheasee-settings.json is an initialized workspace, and anything else is
// refused — cheasee-pi never auto-initializes existing folders.
func classifyWorkspace(workdir string) (WorkspaceState, error) {
	if _, err := os.Stat(cheaseeSettingsPath(workdir)); err == nil {
		return WorkspaceInitialized, nil
	}
	entries, err := os.ReadDir(workdir)
	if err != nil {
		return 0, fmt.Errorf("inspect workspace %q: %w", workdir, err)
	}
	for _, e := range entries {
		if e.Name() == ".DS_Store" {
			continue
		}
		return WorkspaceRefuse, nil
	}
	return WorkspaceEmpty, nil
}

func containerRunning(name string) (bool, error) {
	cmd := execCommand("docker", "ps", "--filter", fmt.Sprintf("name=%s", name), "--format", "{{.Names}}")
	out, err := cmd.Output()
	if err != nil {
		return false, fmt.Errorf("docker ps: %w", err)
	}
	return strings.TrimSpace(string(out)) == name, nil
}

// dockerComposeUp builds and starts the container from the cache dir. The
// compose file lives at composeDir/docker-compose.yml; the workspace root
// (workspaceHostPath) is injected as WORKSPACE_HOST_PATH and its sibling bare
// repo as WORKSPACE_BARE_PATH — CLI-resolved absolute paths, never ${PWD}
// (macOS logical-vs-resolved path pitfall).
// waitHealthy polls the container health until healthy or the timeout
// expires (2s interval). The entrypoint touches /tmp/.cheasee-pi-ready only
// after all setup completes, so healthy implies pi can exec safely.
func waitHealthy(ctx context.Context, name string) error {
	deadline := time.Now().Add(healthWaitTimeout)
	for {
		status, err := containerHealth(ctx, name)
		if err != nil {
			return err
		}
		if status == "healthy" {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("container %s not healthy after %s (status %q) — check `docker logs %s` for entrypoint errors", name, healthWaitTimeout, status, name)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// containerHealth returns the container's health status via docker inspect.
func containerHealth(ctx context.Context, name string) (string, error) {
	cmd := execCommand("docker", "inspect", "--format", "{{.State.Health.Status}}", name)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("docker inspect: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

// healthWaitTimeout bounds the ready-wait before execing pi. First-run npm
// install dominates (workspace deps); generous by default.
var healthWaitTimeout = 5 * time.Minute

func dockerComposeUp(ctx context.Context, composeDir, workspaceHostPath, containerName string) error {
	composeFile := filepath.Join(composeDir, "docker-compose.yml")

	// Fail closed when the sibling bare repo is missing: the worktree's gitdir
	// points into <parent>/.bare, and a compose up would otherwise let Docker's
	// create_host_path auto-create a stray empty host dir that breaks the
	// mount/worktree-fix contract. Recovery hint instead of a silent stray dir.
	bareDir := filepath.Join(filepath.Dir(workspaceHostPath), ".bare")
	if _, err := os.Stat(bareDir); err != nil {
		return fmt.Errorf("workspace is corrupt: bare repository %s is missing (cheasee-settings.json present, no .bare sibling) — re-run `cheasee-pi init` in an empty folder and clone again", bareDir)
	}

	// Build with a per-build cache-busting stamp so the pi-coding-agent
	// layer always re-resolves @latest (Docker caches RUN layers on the
	// command text + ARG values; an unchanging ARG means a stale pi).
	stamp := fmt.Sprintf("%d", time.Now().Unix())
	build := runCommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"build", "--build-arg", "PI_BUILD_STAMP="+stamp,
	)
	build.SetStdout(os.Stderr)
	build.SetStderr(os.Stderr)
	// compose validates every volume spec even for `build`, so
	// WORKSPACE_HOST_PATH/WORKSPACE_BARE_PATH must be set here too (memory/
	// cpus/git identity from settings.json ride along).
	applyComposeEnv(build, workspaceHostPath, containerName)
	fmt.Fprintf(os.Stderr, "  ℹ Building container image...\n")
	if err := build.Run(); err != nil {
		return err
	}

	cmd := runCommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"up", "-d", "--remove-orphans",
	)
	cmd.SetStdout(os.Stderr)
	cmd.SetStderr(os.Stderr)
	applyComposeEnv(cmd, workspaceHostPath, containerName)
	fmt.Fprintf(os.Stderr, "  ℹ Starting container...\n")
	if err := cmd.Run(); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "  ✓ Container started\n")
	return nil
}

// applyComposeEnv sets the compose-up environment: the CLI-resolved absolute
// workspace host path plus its sibling bare repo (<parent>/.bare) — two
// sibling bind mounts (folder→/workspaces/main, bare→/workspaces/.bare), never
// a single parent-of-folder mount — plus resource limits and git identity
// from cheasee-settings.json (replacing the old docker/.env file and the
// pi-coupled .pi/settings.json read). SELinux-enforcing hosts opt in to
// bind-mount relabeling via CHEASEEPI_SELINUX_RELABEL=1 (appends :Z to every
// bind mount — documented, not default: relabel cost).
// containerName returns the daemon container name for a workspace: the repo
// slug suffixed to the service prefix. The slug comes from the bare repo's
// remote (the actual repo name), falling back to the workspace folder name.
// Distinct repos get distinct containers — two workspaces run side by side.
func containerName(workspaceRoot string) string {
	return "cheasee-pi-" + repoSlug(workspaceRoot)
}

// codeflowContainerName follows the same repo-slug scheme for the codeflow
// sidecar service.
func codeflowContainerName(workspaceRoot string) string {
	return "codeflow-" + repoSlug(workspaceRoot)
}

// repoSlug is the docker-safe repo name for a workspace: the sibling bare
// repo's remote URL repository name when resolvable, else the workspace
// basename. Lowercased, non-alphanumerics → '-'
// (ponytail: git config call per run, cached only if it ever shows up in
// profiles — a subprocess read of one config key is sub-millisecond).
func repoSlug(workspaceRoot string) string {
	if name := bareRepoName(workspaceRoot); name != "" {
		return sanitizeSlug(name)
	}
	return sanitizeSlug(filepath.Base(workspaceRoot))
}

// bareRepoName reads remote.origin.url from the sibling bare repo, returning
// the trailing repo name (e.g. "cheasee-pi" from
// https://github.com/owner/cheasee-pi.git). Empty on any error.
func bareRepoName(workspaceRoot string) string {
	bare := filepath.Join(filepath.Dir(workspaceRoot), ".bare")
	cmd := execCommand("git", "--git-dir", bare, "config", "--get", "remote.origin.url")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	name := strings.TrimSpace(string(out))
	name = strings.TrimSuffix(name, ".git")
	if i := strings.LastIndexAny(name, "/:"); i >= 0 {
		name = name[i+1:]
	}
	return name
}

// sanitizeSlug lowercases and maps non-alphanumerics to '-' so the slug is
// a valid docker container-name character set.
func sanitizeSlug(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

func applyComposeEnv(cmd runner, workspaceHostPath, containerName string) {
	env := append(os.Environ(),
		"WORKSPACE_HOST_PATH="+workspaceHostPath,
		"WORKSPACE_BARE_PATH="+filepath.Join(filepath.Dir(workspaceHostPath), ".bare"),
		// Container names carry the repo slug so distinct workspaces get
		// distinct containers (compose interpolates them into container_name).
		"CHEASEEPI_CONTAINER="+containerName,
		"CODEFLOW_CONTAINER="+codeflowContainerName(workspaceHostPath),
	)
	if os.Getenv("CHEASEEPI_SELINUX_RELABEL") == "1" {
		env = append(env, "VOLUME_RELABEL=:Z")
		fmt.Fprintf(os.Stderr, "  ℹ SELinux relabeling enabled: appending :Z to bind mounts\n")
	}
	if mem, ok := memoryLimitEnv(workspaceHostPath); ok {
		env = append(env, mem)
		fmt.Fprintf(os.Stderr, "  ℹ Using memory limit %s from cheasee-settings.json\n", envValue(mem))
	}
	if s, err := LoadCheaseeSettings(workspaceHostPath); err == nil {
		if s.Docker.CPUs != "" {
			env = append(env, "CHEASEEPI_CPUS="+s.Docker.CPUs)
		}
		if s.GitIdentity.Name != "" {
			env = append(env, "HOST_GIT_NAME="+s.GitIdentity.Name)
		}
		if s.GitIdentity.Email != "" {
			env = append(env, "HOST_GIT_EMAIL="+s.GitIdentity.Email)
		}
	}
	cmd.SetEnv(env)
}

// buildEnvFlags collects the env vars to inject into the container: provider
// keys from auth.json resolved through ProviderToEnvVar, the --api-key
// override, and passthrough env vars from the current process. Provider names
// flow in sorted order so alias collisions (claude + anthropic →
// ANTHROPIC_API_KEY) resolve deterministically (last write wins).
func buildEnvFlags(ctx context.Context) (map[string]string, error) {
	envMap := make(map[string]string)

	// 1. Provider keys from auth.json
	repo := newRepository()
	providers, err := repo.ListProviders(ctx)
	if err != nil {
		return nil, fmt.Errorf("read auth.json: %w", err)
	}

	for _, provider := range slices.Sorted(maps.Keys(providers)) {
		key := providers[provider]
		envVar := ProviderToEnvVar(provider)
		if envVar == "" {
			// Unknown provider — pass as-is
			envVar = strings.ToUpper(provider) + "_API_KEY"
		}
		envMap[envVar] = key
	}

	// 2. --api-key flag overrides OPENCODE_API_KEY
	if upAPIKey != "" {
		envMap["OPENCODE_API_KEY"] = upAPIKey
	}

	// 3. Passthrough known env vars from current process (auth.json wins)
	for _, envVar := range AllEnvVarNames() {
		if _, ok := envMap[envVar]; ok {
			continue
		}
		if val := os.Getenv(envVar); val != "" {
			envMap[envVar] = val
		}
	}

	// 4. Extract gh token if not already in env
	if os.Getenv("GH_TOKEN") == "" {
		if token, err := extractGHToken(); err == nil && token != "" {
			envMap["GH_TOKEN"] = token
		}
	}

	return envMap, nil
}

// redactEnvValue shortens a secret for dry-run output: values longer than
// 8 chars show the first and last 4 chars; shorter values print in full.
func redactEnvValue(v string) string {
	if len(v) > 8 {
		return v[:4] + "..." + v[len(v)-4:]
	}
	return v
}

func extractGHToken() (string, error) {
	cmd := exec.Command("gh", "auth", "token")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// execArgs builds docker exec args that run pi directly in the given
// container working directory (e.g. /workspaces/main or /workspaces/main/sub).
// On disconnect, docker exec sends SIGKILL to the container's pid 1,
// which propagates to pi and all its children — no wrapper needed.
func execArgs(env map[string]string, name, target string) []string {
	// Sorted keys keep the -e flag order deterministic (Go map iteration
	// order is randomized by spec).
	args := []string{"exec"}
	for _, envVar := range slices.Sorted(maps.Keys(env)) {
		args = append(args, "-e", envVar+"="+env[envVar])
	}
	args = append(args,
		"-it",
		"--user", "agentuser",
		"-w", target,
		name,
		"/usr/bin/pi", "--approve",
	)
	return args
}

// execPIContainer runs docker exec with the injected env in the container
// working directory target. Package-var seam (newRepository/runCommandContext
// pattern): tests override it to observe the non-dry-run exec without a real
// docker daemon.
var execPIContainer = func(name string, env map[string]string, target string) error {
	args := execArgs(env, name, target)

	cmd := exec.Command("docker", args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	return cmd.Run()
}
