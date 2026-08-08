package main

import (
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "cheasee-pi",
	Short: "Cheasee-PI — Token-saving Pi agent harness with Docker setup",
	Long: `Cheasee-PI is a Pi agent harness built on the Pi coding agent (pi.dev).
Its init command authenticates with GitHub, clones your fork, and extracts
Docker compose files for containerized deployment.

Without a subcommand, launches pi inside the Docker container (same as 'up').`,
	Version:            "0.50",
	DisableAutoGenTag:  true,
	RunE:               runUpE,
}
