package main

import (
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "cheasee-pi",
	Short: "Cheasee-PI — Token-saving Pi agent harness with Docker setup",
	Long: `Cheasee-PI is a Pi agent harness built on the Pi coding agent (pi.dev).
Its init command authenticates with GitHub, clones your fork, configures
submodules, and extracts Docker compose files for containerized deployment.`,
	Version:            "0.33",
	DisableAutoGenTag:  true,
}
