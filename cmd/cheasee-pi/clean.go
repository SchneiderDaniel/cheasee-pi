package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"
)

var cleanName string

var cleanCmd = &cobra.Command{
	Use:   "clean",
	Short: "Kill orphaned pi sessions inside container to free RAM",
	Long: `Kill orphaned pi processes inside the Cheasee-Pi Docker container.

Orphaned pi processes from disconnected docker exec sessions accumulate RAM.
Run this when memory usage is high. Kills only orphaned pi processes
(PPid=1, no parent session) — interactive sessions are NOT affected.
Use 'cheasee-pi start' to start a fresh session.

Examples:
  cheasee-pi clean               # kill orphaned pi in default container
  cheasee-pi clean --name mypi   # specify container name`,
	DisableAutoGenTag: true,
	RunE:              runCleanE,
}

func init() {
	rootCmd.AddCommand(cleanCmd)
	cleanCmd.Flags().StringVar(&cleanName, "name", "cheasee-pi", "Container name")
}

func runCleanE(_ *cobra.Command, _ []string) error {
	name := cleanName

	// Check container exists and is running
	cmd := exec.Command("docker", "ps", "--filter", fmt.Sprintf("name=%s", name), "--format", "{{.Names}}")
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("docker ps: %w", err)
	}
	if string(out) == "" {
		fmt.Fprintf(os.Stderr, "  ℹ Container %q is not running\n", name)
		return nil
	}

	// Delegate to pi-guardian --once (single sweep, kills orphans only)
	guardianCmd := exec.Command("docker", "exec", name, "pi-guardian", "--once")
	guardianOut, guardianErr := guardianCmd.CombinedOutput()
	if guardianErr != nil {
		fmt.Fprintf(os.Stderr, "  ✗ pi-guardian failed: %v\n", guardianErr)
		if len(guardianOut) > 0 {
			fmt.Fprintf(os.Stderr, "  ✗ output: %s\n", strings.TrimSpace(string(guardianOut)))
		}
		return fmt.Errorf("pi-guardian --once: %w", guardianErr)
	}
	if len(guardianOut) > 0 {
		fmt.Fprintf(os.Stderr, "  ✓ %s", strings.TrimSpace(string(guardianOut)))
	}
	fmt.Fprintf(os.Stderr, "  ✓ Orphaned pi processes cleaned in container %q\n", name)
	return nil
}
