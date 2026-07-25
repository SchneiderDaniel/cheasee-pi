package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
)

var cleanName string

var cleanCmd = &cobra.Command{
	Use:   "clean",
	Short: "Kill orphaned pi sessions and prune dangling images",
	Long: `Kill orphaned pi processes inside the Cheasee-Pi Docker container and
prune dangling Docker images from old builds.

Pi processes orphaned by disconnected docker exec sessions accumulate RAM.
Run this when memory usage is high. Only kills processes reparented to PID 1
(orphans) — interactive sessions are NOT affected.
Dangling images (from rebuilds) are pruned keeping the tagged in-use image.
Use 'cheasee-pi start' to start a fresh session after cleaning.

Examples:
  cheasee-pi clean               # kill orphaned pi + prune dangling images
  cheasee-pi clean --name mypi   # specify container name`,
	DisableAutoGenTag: true,
	RunE:              runCleanE,
}

func init() {
	rootCmd.AddCommand(cleanCmd)
	cleanCmd.Flags().StringVar(&cleanName, "name", "cheasee-pi", "Container name")
}

// pruneDanglingImages removes all dangling (<none>:<none>) Docker images.
// Tagged/in-use images are never affected.
func pruneDanglingImages() {
	// Check if any dangling images exist first
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

	killed, err := scanOrphans(ctx, cleanName)
	if err != nil {
		return fmt.Errorf("clean: %w", err)
	}
	if killed > 0 {
		fmt.Fprintf(os.Stderr, "  ✓ Killed %d orphaned pi process(es)\n", killed)
	} else {
		fmt.Fprintf(os.Stderr, "  ℹ No orphaned pi processes found\n")
	}

	pruneDanglingImages()
	return nil
}
