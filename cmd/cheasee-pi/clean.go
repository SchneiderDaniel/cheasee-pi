package main

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
)

var cleanName string

var cleanCmd = &cobra.Command{
	Use:   "clean",
	Short: "Kill all pi sessions inside container to free RAM",
	Long: `Kill all pi processes inside the Cheasee-Pi Docker container.

Orphaned pi processes from disconnected docker exec sessions accumulate RAM.
Run this when memory usage is high. Kills ALL pi processes — interactive
sessions AND subagents. Use 'cheasee-pi start' to start a fresh session.

Examples:
  cheasee-pi clean               # kill all pi in default container
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

	// Kill all pi processes (any stdin state, any PPid)
	killCmd := exec.Command("docker", "exec", name, "sh", "-c",
		`for d in /proc/[0-9]*/cmdline; do
			[ -r "$d" ] || continue
			grep -aq "^pi" "$d" 2>/dev/null || continue
			kill "$(basename "$(dirname "$d")")" 2>/dev/null
		done`,
	)
	if out, err := killCmd.CombinedOutput(); err == nil && len(out) > 0 {
		fmt.Fprintf(os.Stderr, "  ✓ Cleaned stale pi sessions\n")
	}
	fmt.Fprintf(os.Stderr, "  ✓ All pi sessions killed in container %q\n", name)
	return nil
}
