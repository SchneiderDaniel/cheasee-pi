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

Runs from your own git repository: the repo toplevel is bind-mounted at
/workspaces/main inside the container. compose/Dockerfile live in a
CLI-managed cache dir; only .pi/settings.json is scaffolded into the repo
(created if missing, never overwritten). The image clones the cheasee-pi
repo at build time (Dockerfile ARG CHEASEE_REF) for its .pi resources.

Reads provider API keys from ~/.config/cheasee-pi/auth.json and passes them as
environment variables to the container, so pi finds models without manual /login.

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

	// Phase 1: verify the current directory is a git repository (toplevel).
	// Runs before any docker invocation — a non-git cwd is refused fast.
	root, relCwd, err := repoRoot(workdir)
	if err != nil {
		return err
	}

	// docker exec working directory: /workspaces/main when started at the
	// toplevel, /workspaces/main/<rel> when started from a subdirectory.
	target := "/workspaces/main"
	if relCwd != "" && relCwd != "." {
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

	// Phase 5: scaffold .pi/settings.json into the repo root (idempotent —
	// never overwrites an existing file). Absolute /opt/cheasee-pi paths.
	scaffolded, err := runUpScaffold(ctx, root)
	if err != nil {
		return fmt.Errorf("settings scaffold: %w", err)
	}
	if scaffolded {
		fmt.Fprintf(os.Stderr, "  ✓ Created .pi/settings.json in %s\n", root)
	}

	// Phase 6: ensure the version-keyed cache dir with embedded compose
	// assets (regenerable; a fresh extraction overwrites cleanly).
	cacheDir, err := ensureCacheDir(ctx)
	if err != nil {
		return fmt.Errorf("cache dir: %w", err)
	}
	if err := NewExtractor().Extract(ctx, cacheDir); err != nil {
		return fmt.Errorf("extract compose files: %w", err)
	}

	// Phase 7: Ensure container running
	running, err := containerRunning(upName)
	if err != nil {
		return fmt.Errorf("check container: %w", err)
	}

	if upBuild || !running {
		if err := dockerComposeUp(ctx, cacheDir, root); err != nil {
			return fmt.Errorf("docker compose up: %w", err)
		}
	}

	// Phase 8: Run pre-start orphan scan (best-effort)
	killed, err := scanOrphans(ctx, upName)
	if err != nil {
		return fmt.Errorf("pre-start orphan scan: %w", err)
	}
	if killed > 0 {
		fmt.Fprintf(os.Stderr, "  ✓ Killed %d orphaned pi process(es)\n", killed)
	}

	// Phase 9: exec pi
	return execPIContainer(upName, envMap, target)
}

// runUpScaffold writes .pi/settings.json into the repo root when missing
// (never overwrites) and reports whether it created one. start is
// non-interactive: git identity comes from git config with cheasee-pi
// defaults on empty, no prompts.
func runUpScaffold(ctx context.Context, root string) (bool, error) {
	if _, err := os.Stat(settingsPath(root)); err == nil {
		return false, nil
	}
	gitName, gitEmail, _ := NewGitIdentity().Lookup()
	if gitName == "" {
		gitName = "Cheasee-Pi"
	}
	if gitEmail == "" {
		gitEmail = "cheasee-pi@localhost"
	}
	vals := TemplateSettingsValues{
		Provider:     initProvider,
		GitName:      gitName,
		GitEmail:     gitEmail,
		Memory:       "2G",
		CPUs:         "2.0",
		HasPrivatePi: false,
	}
	if err := NewSettingsScaffold().Scaffold(ctx, root, vals); err != nil {
		return false, err
	}
	return true, nil
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
// compose file lives at composeDir/docker-compose.yml; the user repo toplevel
// (workspaceHostPath) is injected as WORKSPACE_HOST_PATH — the CLI-resolved
// absolute path, never ${PWD} (macOS logical-vs-resolved path pitfall).
func dockerComposeUp(ctx context.Context, composeDir, workspaceHostPath string) error {
	composeFile := filepath.Join(composeDir, "docker-compose.yml")

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
	applyComposeEnv(cmd, workspaceHostPath)
	fmt.Fprintf(os.Stderr, "  ℹ Starting container...\n")
	if err := cmd.Run(); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "  ✓ Container started\n")
	return nil
}

// applyComposeEnv sets the compose-up environment: the CLI-resolved absolute
// workspace host path, plus resource limits and git identity from
// .pi/settings.json (replacing the old docker/.env file). SELinux-enforcing
// hosts opt in to bind-mount relabeling via CHEASEEPI_SELINUX_RELABEL=1
// (appends :Z to every bind mount — documented, not default: relabel cost).
func applyComposeEnv(cmd runner, workspaceHostPath string) {
	env := append(os.Environ(), "WORKSPACE_HOST_PATH="+workspaceHostPath)
	if os.Getenv("CHEASEEPI_SELINUX_RELABEL") == "1" {
		env = append(env, "VOLUME_RELABEL=:Z")
		fmt.Fprintf(os.Stderr, "  ℹ SELinux relabeling enabled: appending :Z to bind mounts\n")
	}
	if mem, ok := memoryLimitEnv(workspaceHostPath); ok {
		env = append(env, mem)
		fmt.Fprintf(os.Stderr, "  ℹ Using memory limit %s from settings.json\n", envValue(mem))
	}
	if s, err := LoadSettings(workspaceHostPath); err == nil {
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
