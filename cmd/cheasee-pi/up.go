package main

import (
	"context"
	"encoding/json"
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

	// Phase 1: Docker check
	if !upNoDockerCheck {
		if err := runInitDockerCheck(ctx); err != nil {
			return err
		}
	}

	// Phase 2: Ensure container running
	running, err := containerRunning(upName)
	if err != nil {
		return fmt.Errorf("check container: %w", err)
	}

	if upBuild || !running {
		if err := dockerComposeUp(ctx, workdir); err != nil {
			return fmt.Errorf("docker compose up: %w", err)
		}
	}

	// Phase 3: Run pre-start orphan scan (best-effort)
	killed, err := scanOrphans(ctx, upName)
	if err != nil {
		return fmt.Errorf("pre-start orphan scan: %w", err)
	}
	if killed > 0 {
		fmt.Fprintf(os.Stderr, "  ✓ Killed %d orphaned pi process(es)\n", killed)
	}

	// Phase 4: Build env map from auth.json + gh token + --api-key
	envMap, err := buildEnvFlags(ctx)
	if err != nil {
		return fmt.Errorf("build env vars: %w", err)
	}

	if len(envMap) == 0 {
		fmt.Fprintf(os.Stderr, "  ⚠ No provider keys found. Models may not be available.\n")
		fmt.Fprintf(os.Stderr, "  ℹ Use: cheasee-pi auth add <provider>\n")
	}

	// Phase 5: Print env vars or exec pi
	if upDryRun {
		fmt.Fprintf(os.Stderr, "Env vars to be injected:\n")
		for _, envVar := range slices.Sorted(maps.Keys(envMap)) {
			fmt.Fprintf(os.Stderr, "  %s=%s\n", envVar, redactEnvValue(envMap[envVar]))
		}
		// Show full docker command for debugging
		args := execArgs(envMap, upName)
		fmt.Fprintf(os.Stderr, "\nDocker command:\n  docker %s\n", strings.Join(args, " "))
		return nil
	}

	return execPIContainer(upName, envMap)
}

func containerRunning(name string) (bool, error) {
	cmd := exec.Command("docker", "ps", "--filter", fmt.Sprintf("name=%s", name), "--format", "{{.Names}}")
	out, err := cmd.Output()
	if err != nil {
		return false, fmt.Errorf("docker ps: %w", err)
	}
	return strings.TrimSpace(string(out)) == name, nil
}

func dockerComposeUp(ctx context.Context, workdir string) error {
	composeDir := filepath.Join(workdir, "docker")
	composeFile := filepath.Join(composeDir, "docker-compose.yml")

	// Build with a per-build cache-busting stamp so the pi-coding-agent
	// layer always re-resolves @latest (Docker caches RUN layers on the
	// command text + ARG values; an unchanging ARG means a stale pi).
	stamp := fmt.Sprintf("%d", time.Now().Unix())
	build := exec.CommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"build", "--build-arg", "PI_BUILD_STAMP="+stamp,
	)
	build.Stdout = os.Stderr
	build.Stderr = os.Stderr
	fmt.Fprintf(os.Stderr, "  ℹ Building container image...\n")
	if err := build.Run(); err != nil {
		return err
	}

	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"up", "-d", "--remove-orphans",
	)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	// Read docker.memory from .pi/settings.json to set CHEASEEPI_MEMORY
	settingsPath := filepath.Join(workdir, ".pi", "settings.json")
	data, err := os.ReadFile(settingsPath)
	if err == nil {
		var s struct {
			Docker struct {
				Memory string `json:"memory"`
			} `json:"docker"`
		}
		if json.Unmarshal(data, &s) == nil && s.Docker.Memory != "" {
			cmd.Env = append(os.Environ(), "CHEASEEPI_MEMORY="+s.Docker.Memory)
			fmt.Fprintf(os.Stderr, "  ℹ Using memory limit %s from settings.json\n", s.Docker.Memory)
		}
	}
	fmt.Fprintf(os.Stderr, "  ℹ Starting container...\n")
	if err := cmd.Run(); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "  ✓ Container started\n")
	return nil
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

// execArgs builds docker exec args that run pi directly.
// On disconnect, docker exec sends SIGKILL to the container's pid 1,
// which propagates to pi and all its children — no wrapper needed.
func execArgs(env map[string]string, name string) []string {
	// Sorted keys keep the -e flag order deterministic (Go map iteration
	// order is randomized by spec).
	args := []string{"exec"}
	for _, envVar := range slices.Sorted(maps.Keys(env)) {
		args = append(args, "-e", envVar+"="+env[envVar])
	}
	args = append(args,
		"-it",
		"--user", "agentuser",
		"-w", "/workspaces/main",
		name,
		"/usr/bin/pi", "--approve",
	)
	return args
}

func execPIContainer(name string, env map[string]string) error {
	args := execArgs(env, name)

	cmd := exec.Command("docker", args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	return cmd.Run()
}
