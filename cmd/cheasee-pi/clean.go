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
var cleanDryRun bool
var cleanYes bool

// cleanConfirmFn is the y/N gate before killing pi sessions; overridable in
// tests. Abort (false) leaves every session untouched.
var cleanConfirmFn = promptConfirm

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

Before killing anything, clean lists the matching sessions and asks for
confirmation — a session older than the threshold that you are still
actively using would otherwise die with the stragglers. --yes skips the
prompt, --dry-run only shows what would happen.
Dangling images and build cache (intermediate layers) are pruned.
Use 'cheasee-pi start' to start a fresh session after cleaning.

Examples:
  cheasee-pi clean               # preview, confirm, then kill sessions >30m old + prune
  cheasee-pi clean --dry-run     # show what would be killed, touch nothing
  cheasee-pi clean --yes         # skip the confirmation prompt
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
	cleanCmd.Flags().BoolVar(&cleanDryRun, "dry-run", false, "Show what would be killed and pruned without touching anything")
	cleanCmd.Flags().BoolVar(&cleanYes, "yes", false, "Skip the confirmation prompt")
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

// printCleanReport lists the sessions a clean pass matched.
func printCleanReport(candidates []string) {
	fmt.Fprintf(os.Stderr, "  %d pi session(s) matched the stale/orphan reapers:\n", len(candidates))
	for _, c := range candidates {
		fmt.Fprintf(os.Stderr, "    %s\n", c)
	}
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

	if cleanDryRun {
		candidates, err := scanOrphans(ctx, cleanName, cleanMaxAge, true)
		if err != nil {
			return fmt.Errorf("clean: %w", err)
		}
		if len(candidates) == 0 {
			fmt.Fprintf(os.Stderr, "  ℹ No stale pi sessions found\n")
		} else {
			printCleanReport(candidates)
		}
		fmt.Fprintf(os.Stderr, "  ℹ Dry-run: dangling images + build cache would also be pruned\n")
		return nil
	}

	if cleanYes {
		// Non-interactive: single real scan, no preview pass.
		killed, err := scanOrphans(ctx, cleanName, cleanMaxAge, false)
		if err != nil {
			return fmt.Errorf("clean: %w", err)
		}
		if len(killed) > 0 {
			fmt.Fprintf(os.Stderr, "  ✓ Killed %d pi session(s)\n", len(killed))
		} else {
			fmt.Fprintf(os.Stderr, "  ℹ No stale pi sessions found\n")
		}
	} else {
		// Preview first, then confirm before killing anything.
		candidates, err := scanOrphans(ctx, cleanName, cleanMaxAge, true)
		if err != nil {
			return fmt.Errorf("clean: %w", err)
		}
		if len(candidates) == 0 {
			fmt.Fprintf(os.Stderr, "  ℹ No stale pi sessions found\n")
		} else {
			printCleanReport(candidates)
			ok, err := cleanConfirmFn(fmt.Sprintf("Kill %d pi session(s)?", len(candidates)))
			if err != nil {
				return fmt.Errorf("clean: %w", err)
			}
			if !ok {
				fmt.Fprintf(os.Stderr, "  ✗ Aborted — no sessions killed\n")
			} else {
				killed, err := scanOrphans(ctx, cleanName, cleanMaxAge, false)
				if err != nil {
					return fmt.Errorf("clean: %w", err)
				}
				fmt.Fprintf(os.Stderr, "  ✓ Killed %d pi session(s)\n", len(killed))
			}
		}
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


