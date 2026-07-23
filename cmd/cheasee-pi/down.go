package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/spf13/cobra"
)

var downWorkdir string

var downCmd = &cobra.Command{
	Use:     "down",
	Aliases: []string{"stop"},
	Short:   "Stop and remove the Docker container",
	Long: `Stop and remove the Cheasee-Pi Docker container via docker compose down.

Stops the container and removes it, avoiding name collision on next start.

Examples:
  cheasee-pi down                # stop default container
  cheasee-pi down --workdir ..   # specify project directory`,
	DisableAutoGenTag: true,
	RunE:              runDownE,
}

func init() {
	rootCmd.AddCommand(downCmd)
	downCmd.Flags().StringVar(&downWorkdir, "workdir", "", "Working directory (default: current directory)")
}

func runDownE(_ *cobra.Command, _ []string) error {
	workdir, err := resolveWorkdir(downWorkdir)
	if err != nil {
		return fmt.Errorf("resolve workdir: %w", err)
	}

	composeDir := filepath.Join(workdir, "docker")
	cmd := exec.Command("docker", "compose",
		"-f", filepath.Join(composeDir, "docker-compose.yml"),
		"down",
	)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr

	fmt.Fprintf(os.Stderr, "  ℹ Stopping container...\n")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker compose down: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Container stopped and removed\n")
	return nil
}
