package main

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var cleanName string

var cleanCmd = &cobra.Command{
	Use:   "clean",
	Short: "Kill orphaned pi sessions inside container to free RAM",
	Long: `Kill orphaned pi processes inside the Cheasee-Pi Docker container.

Pi processes orphaned by disconnected docker exec sessions accumulate RAM.
Run this when memory usage is high. Only kills processes reparented to PID 1
(orphans) — interactive sessions are NOT affected.
Use 'cheasee-pi start' to start a fresh session after cleaning.

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
	return nil
}
