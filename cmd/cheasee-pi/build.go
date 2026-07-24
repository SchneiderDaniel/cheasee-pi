package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"
)

var (
	buildWorkdir       string
	buildNoDockerCheck bool
)

var buildCmd = &cobra.Command{
	Use:   "build",
	Short: "Rebuild the Docker container image",
	Long: `Rebuild the Cheasee-Pi Docker image without starting the container.

Reads docker.memory from .pi/settings.json and passes it as CHEASEEPI_MEMORY
build arg so the container can apply cgroup limits at runtime.

Useful after Dockerfile, entrypoint, or dependency changes.
For a full start (build + container up + pi), use 'cheasee-pi start --build'.

Examples:
  cheasee-pi build               # rebuild image
  cheasee-pi build --workdir ..   # rebuild in specific workspace`,
	DisableAutoGenTag: true,
	RunE:              runBuildE,
}

func init() {
	rootCmd.AddCommand(buildCmd)
	buildCmd.Flags().StringVar(&buildWorkdir, "workdir", "", "Working directory (default: current directory)")
	buildCmd.Flags().BoolVar(&buildNoDockerCheck, "no-docker-check", false, "Skip Docker Engine check")
}

func runBuildE(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}

	workdir, err := resolveWorkdir(buildWorkdir)
	if err != nil {
		return fmt.Errorf("resolve workdir: %w", err)
	}

	if !buildNoDockerCheck {
		checker := NewChecker(5 * time.Second)
		if err := runInitDockerCheck(ctx, checker); err != nil {
			return err
		}
	}

	composeDir := filepath.Join(workdir, "docker")
	buildCmd := exec.CommandContext(ctx, "docker", "compose",
		"-f", filepath.Join(composeDir, "docker-compose.yml"),
		"build",
	)

	// Read docker.memory from .pi/settings.json to set CHEASEEPI_MEMORY build arg
	settingsPath := filepath.Join(workdir, ".pi", "settings.json")
	data, err := os.ReadFile(settingsPath)
	if err == nil {
		var s struct {
			Docker struct {
				Memory string `json:"memory"`
			} `json:"docker"`
		}
		if json.Unmarshal(data, &s) == nil && s.Docker.Memory != "" {
			buildCmd.Env = append(os.Environ(), "CHEASEEPI_MEMORY="+s.Docker.Memory)
			fmt.Fprintf(os.Stderr, "  ℹ Using memory limit %s from settings.json\n", s.Docker.Memory)
		}
	}

	buildCmd.Stdout = os.Stderr
	buildCmd.Stderr = os.Stderr

	fmt.Fprintf(os.Stderr, "  ℹ Building container image...\n")
	if err := buildCmd.Run(); err != nil {
		return fmt.Errorf("docker compose build: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Image built\n")
	return nil
}
