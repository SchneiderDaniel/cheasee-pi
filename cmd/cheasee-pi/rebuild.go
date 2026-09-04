package main

import (
	"context"

	"github.com/spf13/cobra"
)

// rebuildCmd performs the full no-cache rebuild: compose build with
// --no-cache (ignore every cached layer) and --pull (refresh the base image),
// then a post-build prune of dangling images and the build cache so the image
// this rebuild just orphaned is reclaimed immediately. Containers are never
// touched — that stays `clean`'s job.
var rebuildCmd = &cobra.Command{
	Use:   "rebuild",
	Short: "Full rebuild of the Docker container image without cache plus prune",
	Long: `Fully rebuild the Cheasee-Pi Docker image from scratch, then prune.

The compose/Dockerfile come from the CLI-managed cache dir (version-keyed,
extracted on demand); the workspace is used for git verification and
resource settings. rebuild ignores every cached layer (--no-cache) and pulls
a fresh base image (--pull) — unlike 'cheasee-pi build', which reuses the
Docker layer cache. After the build, dangling images and the build cache are
pruned (containers are left untouched; that is 'cheasee-pi clean').

Note: rebuild = no-cache full rebuild + prune. This inverts VS Code's
"Rebuild Container" naming (which is the cached variant) — use 'cheasee-pi
build' for the cached rebuild.

Examples:
  cheasee-pi rebuild               # full rebuild from scratch + prune
  cheasee-pi rebuild --workdir ..   # rebuild in specific workspace`,
	DisableAutoGenTag: true,
	RunE:              runRebuildE,
}

func init() {
	rootCmd.AddCommand(rebuildCmd)
	// One command per process: rebuild reuses the build flag vars, so the
	// workdir/no-docker-check surfaces stay in sync without per-command state.
	rebuildCmd.Flags().StringVar(&buildWorkdir, "workdir", "", "Working directory (default: current directory)")
	rebuildCmd.Flags().BoolVar(&buildNoDockerCheck, "no-docker-check", false, "Skip Docker Engine check")
}

func runRebuildE(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	return runBuild(ctx, true, true)
}
