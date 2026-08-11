package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
)

var cleanName string
var cleanMaxAge int

var cleanCmd = &cobra.Command{
	Use:   "clean",
	Short: "Kill orphaned/stale pi sessions and prune Docker garbage (dangling images + build cache)",
	Long: `Kill orphaned pi processes inside the Cheasee-Pi Docker container and
prune dangling Docker images and build cache from old rebuilds.

Pi processes orphaned by disconnected docker exec sessions accumulate RAM.
Run this when memory usage is high. Two reapers:
  - PPid=1 orphans (reparented to tini) are always killed.
  - sessions older than --older-than minutes are killed too: docker exec
    clients that disconnect leave pi running with PPid=0 (parent stays the
    host-side shim, invisible inside the container), so age is the only
    in-container signal that a session is a detached straggler.
Interactive sessions are NOT affected while younger than --older-than.
Dangling images and build cache (intermediate layers) are pruned.
Use 'cheasee-pi start' to start a fresh session after cleaning.

Examples:
  cheasee-pi clean               # kill orphaned + sessions >30m old, prune Docker garbage
  cheasee-pi clean --older-than 60
  cheasee-pi clean --older-than 0   # PPid=1 orphans only, no age reaping
  cheasee-pi clean --name mypi   # specify container name`,
	DisableAutoGenTag: true,
	RunE:              runCleanE,
}

func init() {
	rootCmd.AddCommand(cleanCmd)
	cleanCmd.Flags().StringVar(&cleanName, "name", "cheasee-pi", "Container name")
	cleanCmd.Flags().IntVar(&cleanMaxAge, "older-than", 30, "Kill pi sessions older than N minutes (detached docker exec stragglers); 0 disables age-based reaping")
}

// pruneDanglingImages removes all dangling (<none>:<none>) Docker images.
// Tagged/in-use images are never affected.
func pruneDanglingImages() {
	ls := exec.Command("docker", "images", "--filter", "dangling=true", "-q")
	out, err := ls.Output()
	if err != nil || len(out) == 0 {
		return
	}
	cmd := exec.Command("docker", "image", "prune", "-f")
	if err := cmd.Run(); err != nil {
		return
	}
	fmt.Fprintf(os.Stderr, "  ✓ Pruned dangling Docker images\n")
}

func runCleanE(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}

	// Default container name follows the workspace repo slug (like start);
	// --name overrides verbatim.
	if !cmd.Flags().Changed("name") {
		if wd, err := os.Getwd(); err == nil {
			if root, ok := findWorkspaceRoot(wd); ok {
				cleanName = containerName(root)
			}
		}
	}

	killed, err := scanOrphans(ctx, cleanName, cleanMaxAge)
	if err != nil {
		return fmt.Errorf("clean: %w", err)
	}
	if killed > 0 {
		fmt.Fprintf(os.Stderr, "  ✓ Killed %d orphaned pi process(es)\n", killed)
	} else {
		fmt.Fprintf(os.Stderr, "  ℹ No orphaned pi processes found\n")
	}

	pruneDanglingImages()
	pruneBuildCache()

	return nil
}

// pruneBuildCache removes the Docker buildx build cache.
// Safe to run unconditionally — fast when empty.
func pruneBuildCache() {
	cmd := exec.Command("docker", "buildx", "prune", "-f")
	if err := cmd.Run(); err == nil {
		fmt.Fprintf(os.Stderr, "  ✓ Pruned Docker build cache\n")
	}
}


