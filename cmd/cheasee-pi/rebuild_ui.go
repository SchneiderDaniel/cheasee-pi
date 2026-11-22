package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

var rebuildUICmd = &cobra.Command{
	Use:     "rebuild-ui",
	GroupID: groupIDMaintenance,
	Short:   "Rebuild and apply only the UI sidecar",
	Long: `Rebuild the UI sidecar image using the Docker layer cache, then recreate
only the UI container. The Cheasee-Pi agent and CodeFlow services are untouched.

The Compose file and UI build context come from the CLI-managed cache dir,
extracted on demand. When developing this repository, run via ` + "`go run ./cmd/cheasee-pi rebuild-ui`" + ` so the build uses the current embedded UI sources.

Examples:
  cheasee-pi rebuild-ui
  go run ./cmd/cheasee-pi rebuild-ui --workdir ..`,
	DisableAutoGenTag: true,
	RunE:              runRebuildUIE,
}

func init() {
	rootCmd.AddCommand(rebuildUICmd)
	rebuildUICmd.Flags().StringVar(&buildWorkdir, "workdir", "", "Working directory (default: current directory)")
	rebuildUICmd.Flags().BoolVar(&buildNoDockerCheck, "no-docker-check", false, "Skip Docker Engine check")
}

func runRebuildUIE(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	return runRebuildUI(ctx)
}

func runRebuildUI(ctx context.Context) error {
	workdir, err := resolveWorkdir(buildWorkdir)
	if err != nil {
		return fmt.Errorf("resolve workdir: %w", err)
	}
	root, _, err := repoRoot(workdir)
	if err != nil {
		return err
	}
	if !buildNoDockerCheck {
		if err := runInitDockerCheck(ctx); err != nil {
			return err
		}
	}

	authPath, err := (&fileRepository{}).Path()
	if err != nil {
		return fmt.Errorf("resolve credential file: %w", err)
	}
	if err := ensureAuthFile(authPath); err != nil {
		return err
	}

	composeDir, err := ensureCacheDir(ctx)
	if err != nil {
		return fmt.Errorf("cache dir: %w", err)
	}
	if err := NewExtractor().Extract(ctx, composeDir); err != nil {
		return fmt.Errorf("extract compose files: %w", err)
	}
	if err := requireWorkspaceBare(root); err != nil {
		return err
	}

	name := containerName(root)
	if err := composeBuild(ctx, composeDir, root, name, composeBuildSpec{
		services: []string{"ui"},
		label:    "Building UI sidecar image",
		wrapErr:  func(err error) error { return fmt.Errorf("docker compose build ui: %w", err) },
	}); err != nil {
		return err
	}
	if err := composeApplyUI(ctx, composeDir, root, name); err != nil {
		return fmt.Errorf("apply UI sidecar: %w", err)
	}
	fmt.Fprintln(os.Stderr, "  ✓ UI sidecar rebuilt and applied; other services were not touched")
	return nil
}

// composeApplyUI applies the freshly-built UI image to exactly that service.
// --no-deps prevents Compose from starting/recreating agent or CodeFlow, and
// --no-build avoids a second implicit build after composeBuild already built ui.
func composeApplyUI(ctx context.Context, composeDir, workspaceHostPath, containerName string) error {
	if err := requireWorkspaceBare(workspaceHostPath); err != nil {
		return err
	}
	args := []string{
		"compose", "-f", filepath.Join(composeDir, "docker-compose.yml"),
		"up", "-d", "--no-deps", "--no-build", "--pull", "never", "ui",
	}
	cmd := runCommandContext(ctx, "docker", args...)
	cmd.SetStdout(os.Stderr)
	cmd.SetStderr(os.Stderr)
	applyComposeEnv(cmd, workspaceHostPath, containerName, composeDir)
	fmt.Fprintln(os.Stderr, "  ℹ Applying only the UI sidecar...")
	return cmd.Run()
}
