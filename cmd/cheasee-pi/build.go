package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/spf13/cobra"
)

var (
	buildWorkdir       string
	buildNoDockerCheck bool
	buildNoCache       bool
)

var buildCmd = &cobra.Command{
	Use:   "build",
	Short: "Rebuild the Docker container image",
	Long: `Rebuild the Cheasee-Pi Docker image without starting the container.

Reads docker.memory from .pi/settings.json and passes it as CHEASEEPI_MEMORY
build arg so the container can apply cgroup limits at runtime.

Useful after Dockerfile, entrypoint, or dependency changes.
Use --no-cache to force a full rebuild from scratch (ignores Docker layer cache).
For a full start (build + container up + pi), use 'cheasee-pi start --build'.

Examples:
  cheasee-pi build                 # rebuild image (cached)
  cheasee-pi build --no-cache      # full rebuild from scratch
  cheasee-pi build --workdir ..     # rebuild in specific workspace`,
	DisableAutoGenTag: true,
	RunE:              runBuildE,
}

func init() {
	rootCmd.AddCommand(buildCmd)
	buildCmd.Flags().StringVar(&buildWorkdir, "workdir", "", "Working directory (default: current directory)")
	buildCmd.Flags().BoolVar(&buildNoDockerCheck, "no-docker-check", false, "Skip Docker Engine check")
	buildCmd.Flags().BoolVar(&buildNoCache, "no-cache", false, "Force full rebuild from scratch (ignore Docker layer cache)")
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
		if err := runInitDockerCheck(ctx); err != nil {
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

	if buildNoCache {
		buildCmd.Args = append(buildCmd.Args, "--no-cache")
	}

	buildCmd.Stdout = os.Stderr
	buildCmd.Stderr = os.Stderr

	label := "Building container image"
	if buildNoCache {
		label += " (no cache)"
	}
	fmt.Fprintf(os.Stderr, "  ℹ %s...\n", label)
	if err := buildCmd.Run(); err != nil {
		return fmt.Errorf("docker compose build: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Image built\n")
	return nil
}
