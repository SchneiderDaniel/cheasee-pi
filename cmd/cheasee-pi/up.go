package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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

// allKnownEnvVars is the complete set of pi provider env vars.
var allKnownEnvVars = []string{
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"OPENCODE_API_KEY",
	"DEEPSEEK_API_KEY",
	"GEMINI_API_KEY",
	"ANT_LING_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"NVIDIA_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"FIREWORKS_API_KEY",
	"TOGETHER_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MOONSHOT_API_KEY",
	"KIMI_API_KEY",
	"CLOUDFLARE_API_KEY",
	"CLOUDFLARE_ACCOUNT_ID",
	"GH_TOKEN",
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
		checker := NewChecker(5 * time.Second)
		if err := runInitDockerCheck(ctx, checker); err != nil {
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

	// Phase 4: Build env flags from auth.json + gh token + --api-key
	envFlags, err := buildEnvFlags(ctx)
	if err != nil {
		return fmt.Errorf("build env vars: %w", err)
	}

	if len(envFlags) == 0 {
		fmt.Fprintf(os.Stderr, "  ⚠ No provider keys found. Models may not be available.\n")
		fmt.Fprintf(os.Stderr, "  ℹ Use: cheasee-pi auth add <provider>\n")
	}

	// Phase 5: Print env flags or exec pi
	if upDryRun {
		fmt.Fprintf(os.Stderr, "Env vars to be injected:\n")
		for i := 0; i < len(envFlags); i += 2 {
			if envFlags[i] != "-e" || i+1 >= len(envFlags) {
				continue
			}
			val := envFlags[i+1]
			if idx := strings.IndexByte(val, '='); idx > 0 && idx < len(val)-4 {
				val = val[:idx+1] + val[idx+1:idx+5] + "..." + val[len(val)-4:]
			}
			fmt.Fprintf(os.Stderr, "  %s\n", val)
		}
		// Show full docker command for debugging
		args := execArgs(envFlags, upName)
		fmt.Fprintf(os.Stderr, "\nDocker command:\n  docker %s\n", strings.Join(args, " "))
		return nil
	}

	return execPIContainer(upName, envFlags)
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
	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-f", filepath.Join(composeDir, "docker-compose.yml"),
		"up", "-d", "--build", "--remove-orphans",
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

func buildEnvFlags(ctx context.Context) ([]string, error) {
	var envFlags []string

	// 1. Provider keys from auth.json
	repo := NewRepository()
	providers, err := repo.ListProviders(ctx)
	if err != nil {
		return nil, fmt.Errorf("read auth.json: %w", err)
	}

	for provider, key := range providers {
		envVar := providerToEnvVar(provider)
		if envVar != "" {
			envFlags = append(envFlags, "-e", fmt.Sprintf("%s=%s", envVar, key))
		} else {
			// Unknown provider — pass as-is
			envFlags = append(envFlags, "-e", fmt.Sprintf("%s=%s", strings.ToUpper(provider)+"_API_KEY", key))
		}
	}

	// 2. --api-key flag overrides OPENCODE_API_KEY
	if upAPIKey != "" {
		envFlags = stripEnvVar(envFlags, "OPENCODE_API_KEY")
		envFlags = append(envFlags, "-e", fmt.Sprintf("OPENCODE_API_KEY=%s", upAPIKey))
	}

	// 3. Passthrough known env vars from current process
	envMap := make(map[string]bool)
	for i := 0; i < len(envFlags); i += 2 {
		if envFlags[i] != "-e" || i+1 >= len(envFlags) {
			continue
		}
		parts := strings.SplitN(envFlags[i+1], "=", 2)
		if len(parts) == 2 {
			envMap[parts[0]] = true
		}
	}

	for _, envVar := range allKnownEnvVars {
		if envMap[envVar] {
			continue
		}
		if val := os.Getenv(envVar); val != "" {
			envFlags = append(envFlags, "-e", fmt.Sprintf("%s=%s", envVar, val))
		}
	}

	// 4. Extract gh token if not already in env
	if os.Getenv("GH_TOKEN") == "" {
		token, err := extractGHToken()
		if err == nil && token != "" {
			envFlags = append(envFlags, "-e", fmt.Sprintf("GH_TOKEN=%s", token))
		}
	}

	return envFlags, nil
}

func stripEnvVar(flags []string, key string) []string {
	out := make([]string, 0, len(flags))
	for i := 0; i < len(flags); i++ {
		if flags[i] == "-e" && i+1 < len(flags) {
			parts := strings.SplitN(flags[i+1], "=", 2)
			if len(parts) == 2 && parts[0] == key {
				i++
				continue
			}
		}
		out = append(out, flags[i])
	}
	return out
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
func execArgs(envFlags []string, name string) []string {
	args := append([]string{"exec"}, envFlags...)
	args = append(args,
		"-it",
		"--user", "agentuser",
		"-w", "/workspaces/main",
		name,
		"/usr/bin/pi", "--approve",
	)
	return args
}

func execPIContainer(name string, envFlags []string) error {
	args := execArgs(envFlags, name)

	cmd := exec.Command("docker", args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	return cmd.Run()
}
