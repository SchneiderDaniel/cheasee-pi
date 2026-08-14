package main

import (
	"context"
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
	buildNoCache       bool
)

var buildCmd = &cobra.Command{
	Use:   "build",
	Short: "Rebuild the Docker container image",
	Long: `Rebuild the Cheasee-Pi Docker image without starting the container.

Reads docker.memory from cheasee-settings.json and passes it as
CHEASEEPI_MEMORY build arg so the container can apply cgroup limits at
runtime.

The compose/Dockerfile come from the CLI-managed cache dir
(version-keyed, extracted on demand); the workspace is only used for git
verification and resource settings. Use --no-cache to force a full rebuild.

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

	// build runs from a git repo (settings + git identity come from it).
	root, _, err := repoRoot(workdir)
	if err != nil {
		return err
	}

	if !buildNoDockerCheck {
		if err := runInitDockerCheck(ctx); err != nil {
			return err
		}
	}

	cacheDir, err := ensureCacheDir(ctx)
	if err != nil {
		return fmt.Errorf("cache dir: %w", err)
	}
	if err := NewExtractor().Extract(ctx, cacheDir); err != nil {
		return fmt.Errorf("extract compose files: %w", err)
	}

	composeFile := filepath.Join(cacheDir, "docker-compose.yml")
	// Per-build cache-busting stamp so the pi-coding-agent layer always
	// re-resolves @latest (same as dockerComposeUp): Docker caches RUN
	// layers on the command text + ARG values, and an unchanging ARG
	// would serve a stale pi from the layer cache — the "Update
	// Available" nag pointing at a version the image never carries.
	stamp := fmt.Sprintf("%d", time.Now().Unix())
	args := []string{"compose", "-f", composeFile, "build", "--build-arg", "PI_BUILD_STAMP=" + stamp}
	if buildNoCache {
		args = append(args, "--no-cache")
		// Full rebuild re-extracts every layer beside the existing image;
		// stale build cache + dangling images can fill the disk first.
		pruneDanglingImages()
		pruneBuildCache()
	}

	buildCmd := exec.CommandContext(ctx, "docker", args...)
	buildCmd.Dir = cacheDir

	// compose validates every volume spec even for `build`, so
	// WORKSPACE_HOST_PATH must be set (same env application as start/down:
	// memory/cpus/git identity from settings.json ride along).
	applyComposeEnv(execRunner{buildCmd}, root, containerName(root))

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
