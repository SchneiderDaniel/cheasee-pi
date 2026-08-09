package main

import (
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "cheasee-pi",
	Short: "Cheasee-PI — Token-saving Pi agent harness with Docker setup",
	Long: `Cheasee-PI is a Pi agent harness built on the Pi coding agent (pi.dev).
Its init command sets up an empty folder (bare clone + main worktree +
cheasee-settings.json); 'cheasee-pi start' mounts the workspace into the
container and launches pi.

Without a subcommand, launches pi inside the Docker container (same as 'up').`,
	Version:           cliVersionKey,
	DisableAutoGenTag: true,
	RunE:              runUpE,
}
