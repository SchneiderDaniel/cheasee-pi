package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

var downCmd = &cobra.Command{
	Use:     "down",
	Aliases: []string{"stop"},
	Short:   "Stop and remove the Docker container",
	Long: `Stop and remove the Cheasee-Pi Docker container via docker compose down.

The compose file resolves from the CLI-managed cache dir (same project name
'cheasee-pi' as start), so down works from any directory.

Examples:
  cheasee-pi down                # stop default container`,
	DisableAutoGenTag: true,
	RunE:              runDownE,
}

func init() {
	rootCmd.AddCommand(downCmd)
}

func runDownE(_ *cobra.Command, _ []string) error {
	ctx := context.Background()

	cacheDir, err := ensureCacheDir(ctx)
	if err != nil {
		return fmt.Errorf("cache dir: %w", err)
	}
	if err := NewExtractor().Extract(ctx, cacheDir); err != nil {
		return fmt.Errorf("extract compose files: %w", err)
	}

	composeFile := filepath.Join(cacheDir, "docker-compose.yml")
	cmd := runCommandContext(ctx, "docker", "compose", "-f", composeFile, "down")

	// compose validates every volume spec even for `down`, so
	// WORKSPACE_HOST_PATH/WORKSPACE_BARE_PATH must be non-empty. Resolve the
	// workspace root (nearest ancestor with cheasee-settings.json) like start
	// does; fall back to the cwd so down keeps working outside a workspace.
	workspace, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}
	if root, ok := findWorkspaceRoot(workspace); ok {
		workspace = root
	}
	applyComposeEnv(cmd, workspace)

	cmd.SetStdout(os.Stderr)
	cmd.SetStderr(os.Stderr)

	fmt.Fprintf(os.Stderr, "  ℹ Stopping container...\n")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker compose down: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Container stopped and removed\n")
	return nil
}
