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
	Short:   "Stop and remove the Docker container for the current workspace",
	Long: `Stop and remove the Cheasee-Pi Docker container via docker compose down.

The compose project name derives from the current workspace's repository, so
down only touches the container belonging to this workspace — sibling
workspaces' containers keep running. Outside any workspace the identity
derives from the folder basename and down no-ops (nothing to stop) when no
container matches. Legacy pre-derivation containers (project 'cheasee-pi')
are not targeted — 'cheasee-pi clean' removes those.

Examples:
  cheasee-pi down                # stop the current workspace's container`,
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

	// Resolve the workspace root (nearest ancestor with cheasee-settings.json)
	// like start does; fall back to the cwd so down keeps working outside a
	// workspace (the identity then derives from the folder basename).
	workspace, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}
	if root, ok := findWorkspaceRoot(workspace); ok {
		workspace = root
	}

	// No-op gate: nothing in this workspace's project → say so instead of
	// running a compose down that would silently no-op. Pre-derivation
	// containers (project "cheasee-pi") are deliberately not targeted —
	// documented semantic shift; clean removes those.
	project := composeProjectName(workspace)
	containers, err := projectContainers(project)
	if err != nil {
		return fmt.Errorf("check project containers: %w", err)
	}
	if len(containers) == 0 {
		fmt.Fprintf(os.Stderr, "  ℹ No cheasee-pi container found for this workspace (project %q) — nothing to stop\n", project)
		return nil
	}

	cmd := runCommandContext(ctx, "docker", "compose", "-f", composeFile, "down")

	// compose validates every volume spec even for `down`, so
	// WORKSPACE_HOST_PATH/WORKSPACE_BARE_PATH must be non-empty.
	applyComposeEnv(cmd, workspace, containerName(workspace))

	cmd.SetStdout(os.Stderr)
	cmd.SetStderr(os.Stderr)

	fmt.Fprintf(os.Stderr, "  ℹ Stopping container...\n")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker compose down: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Container stopped and removed\n")
	return nil
}
