package main

import (
	"context"
	"fmt"
	"os"
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
	Short: "Rebuild the Docker container image (cached)",
	Long: `Rebuild the Cheasee-Pi Docker image without starting the container.

Reads docker.memory from cheasee-settings.json and passes it as
CHEASEEPI_MEMORY build arg so the container can apply cgroup limits at
runtime.

The compose/Dockerfile come from the CLI-managed cache dir
(version-keyed, extracted on demand); the workspace is only used for git
verification and resource settings. build reuses the Docker layer cache;
use 'cheasee-pi rebuild' for a full no-cache rebuild plus prune, or the
--no-cache flag (kept as a compatibility alias).

Examples:
  cheasee-pi build                 # rebuild image (cached)
  cheasee-pi rebuild               # full rebuild from scratch (no cache + prune)
  cheasee-pi build --no-cache      # legacy alias for a full rebuild
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

// buildOptions parameterizes the compose-build core shared by `build` and
// `rebuild`: which flags compose receives, whether dangling images/build
// cache are pruned around the build, and how the build step is labelled.
type buildOptions struct {
	noCache   bool // pass --no-cache (ignore the Docker layer cache)
	pull      bool // pass --pull (refresh the base image)
	prune     bool // prune dangling images + build cache
	prunePost bool // prune AFTER the build (rebuild); false = before (build --no-cache compat)
	label     bool // mark the build label as a full rebuild
}

func runBuildE(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	return runBuild(ctx, buildOptions{
		noCache: buildNoCache,
		prune:   buildNoCache,
	})
}

// runBuild is the shared build core: compose-arg construction, stamp
// injection, prune ordering and labels. `build` is the cached surface,
// `rebuild` the no-cache full rebuild; the --no-cache flag on `build` keeps
// its historical pre-build prune as a compat path.
func runBuild(ctx context.Context, opts buildOptions) error {
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
	// The pi layer sits after the clone/npm-ci layers (Layer 6c), so this
	// per-build bust re-runs only the pi install — clone + npm ci stay
	// cached across builds.
	stamp := fmt.Sprintf("%d", time.Now().Unix())
	args := []string{"compose", "-f", composeFile, "build", "--build-arg", "PI_BUILD_STAMP=" + stamp}
	if opts.noCache {
		args = append(args, "--no-cache")
	}
	if opts.pull {
		args = append(args, "--pull")
	}

	if opts.prune && !opts.prunePost {
		// Full rebuild re-extracts every layer beside the existing image;
		// stale build cache + dangling images can fill the disk first.
		pruneDanglingImages()
		pruneBuildCache()
	}

	buildCmd := runCommandContext(ctx, "docker", args...)
	buildCmd.SetDir(cacheDir)

	// compose validates every volume spec even for `build`, so
	// WORKSPACE_HOST_PATH must be set (same env application as start/down:
	// memory/cpus/git identity from settings.json ride along).
	applyComposeEnv(buildCmd, root, containerName(root))

	buildCmd.SetStdout(os.Stderr)
	buildCmd.SetStderr(os.Stderr)

	label := "Building container image"
	if opts.noCache {
		label += " (no cache)"
	}
	if opts.label {
		label += ", full rebuild"
	}
	fmt.Fprintf(os.Stderr, "  ℹ %s...\n", label)
	if err := buildCmd.Run(); err != nil {
		return fmt.Errorf("docker compose build: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Image built\n")
	// A running container keeps the old image: compose up -d is the only
	// thing that recreates it, and `cheasee-pi start` skips compose when
	// the container is already up. Spell out the apply step so a build
	// followed by a plain start silently serves the stale image.
	fmt.Fprintf(os.Stderr, "  ℹ Running containers keep the old image — apply with `cheasee-pi start --build` or `cheasee-pi down` + `cheasee-pi start`\n")

	if opts.prune && opts.prunePost {
		// Rebuild reclaims the image it just orphaned: the previous image
		// turns dangling the moment the new build finishes (vs the pre-build
		// prune of `build --no-cache`, which only reclaims leftovers of
		// prior runs). Failed builds skip this — BuildKit self-cleans
		// intermediates and `clean` is the deep-clean path.
		pruneDanglingImages()
		pruneBuildCache()
	}
	return nil
}
