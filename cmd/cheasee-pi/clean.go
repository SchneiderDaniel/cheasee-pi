package main

import (
	"context"
	"fmt"
	"os"
	"strings"

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
	Short: "Kill orphaned/stale pi sessions, remove all cheasee-pi containers and prune Docker garbage",
	Long: `Remove every cheasee-pi container (all repositories), kill orphaned pi
processes inside them, and prune dangling Docker images + build cache.

Since the per-repo container naming, clean enumerates ALL managed containers
on the host — every repository's container (running or stopped) — force-
removes each, and prunes dangling images and build cache from old rebuilds.
Pi processes orphaned by disconnected docker exec sessions accumulate RAM;
the orphan scan runs per container before removal.

WARNING: clean force-removes running containers — active pi sessions inside
them are killed. Use --name to scope the operation to a single container, or
--dry-run to preview.

Before killing anything, clean lists the matching sessions/containers and
asks for confirmation. --yes skips the prompt, --dry-run only shows what
would happen. Dangling images and build cache (intermediate layers) are
pruned. Use 'cheasee-pi start' to start a fresh session after cleaning.

Examples:
  cheasee-pi clean               # preview, confirm, then remove all containers + prune
  cheasee-pi clean --dry-run     # show what would be removed, touch nothing
  cheasee-pi clean --yes         # skip the confirmation prompt
  cheasee-pi clean --older-than 60
  cheasee-pi clean --older-than 0   # PPid=1 orphans only, no age reaping
  cheasee-pi clean --name mypi   # scope to a single container`,
	DisableAutoGenTag: true,
	RunE:              runCleanE,
}

func init() {
	rootCmd.AddCommand(cleanCmd)
	cleanCmd.Flags().StringVar(&cleanName, "name", "cheasee-pi", "Scope clean to this single container (default: all cheasee-pi containers)")
	cleanCmd.Flags().IntVar(&cleanMaxAge, "older-than", 30, "Kill pi sessions older than N minutes (detached docker exec stragglers); 0 disables age-based reaping")
	cleanCmd.Flags().BoolVar(&cleanDryRun, "dry-run", false, "Show what would be killed and pruned without touching anything")
	cleanCmd.Flags().BoolVar(&cleanYes, "yes", false, "Skip the confirmation prompt")
}

// pruneDanglingImages removes all dangling (<none>:<none>) Docker images.
// Tagged/in-use images are never affected.
func pruneDanglingImages() {
	ls := execCommand("docker", "images", "--filter", "dangling=true", "-q")
	out, err := ls.Output()
	if err != nil || len(out) == 0 {
		return
	}
	cmd := execCommand("docker", "image", "prune", "-f")
	if _, err := cmd.CombinedOutput(); err != nil {
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

	// Scope: --name targets a single container; the default is every managed
	// container on the host (all repositories — clean never touches just the
	// current workspace).
	var targets []string
	var err error
	if cmd.Flags().Changed("name") {
		targets = []string{cleanName}
	} else {
		targets, err = listManagedContainers()
		if err != nil {
			return fmt.Errorf("clean: enumerate containers: %w", err)
		}
	}

	if cleanDryRun {
		candidates, err := scanTargets(ctx, targets, true)
		if err != nil {
			return fmt.Errorf("clean: %w", err)
		}
		if len(candidates) == 0 {
			fmt.Fprintf(os.Stderr, "  ℹ No stale pi sessions found\n")
		} else {
			printCleanReport(candidates)
		}
		if len(targets) > 0 {
			fmt.Fprintf(os.Stderr, "  ℹ Would remove %d container(s): %s\n", len(targets), strings.Join(targets, ", "))
		}
		fmt.Fprintf(os.Stderr, "  ℹ Dry-run: dangling images + build cache would also be pruned\n")
		return nil
	}

	if cleanYes {
		if err := cleanAndRemove(ctx, targets); err != nil {
			return fmt.Errorf("clean: %w", err)
		}
	} else {
		candidates, err := scanTargets(ctx, targets, true)
		if err != nil {
			return fmt.Errorf("clean: %w", err)
		}
		if len(candidates) == 0 && len(targets) == 0 {
			fmt.Fprintf(os.Stderr, "  ℹ No stale pi sessions found\n")
		} else {
			if len(candidates) > 0 {
				printCleanReport(candidates)
			}
			ok, err := cleanConfirmFn(cleanPrompt(candidates, targets))
			if err != nil {
				return fmt.Errorf("clean: %w", err)
			}
			if !ok {
				fmt.Fprintf(os.Stderr, "  ✗ Aborted — no sessions killed, no containers removed\n")
			} else if err := cleanAndRemove(ctx, targets); err != nil {
				return fmt.Errorf("clean: %w", err)
			}
		}
	}

	pruneDanglingImages()
	pruneBuildCache()

	return nil
}

// scanTargets runs the orphan scan across every target container and
// aggregates the report lines.
func scanTargets(ctx context.Context, targets []string, dryRun bool) ([]string, error) {
	var all []string
	for _, name := range targets {
		killed, err := scanOrphans(ctx, name, cleanMaxAge, dryRun)
		if err != nil {
			return nil, err
		}
		all = append(all, killed...)
	}
	return all, nil
}

// cleanPrompt builds the confirmation question for the preview pass.
func cleanPrompt(candidates, targets []string) string {
	switch {
	case len(candidates) > 0 && len(targets) > 0:
		return fmt.Sprintf("Kill %d pi session(s) and remove %d container(s)?", len(candidates), len(targets))
	case len(candidates) > 0:
		return fmt.Sprintf("Kill %d pi session(s)?", len(candidates))
	default:
		return fmt.Sprintf("Remove %d container(s)?", len(targets))
	}
}

// cleanAndRemove runs the real orphan scan across the targets, reports, then
// force-removes the containers.
func cleanAndRemove(ctx context.Context, targets []string) error {
	killed, err := scanTargets(ctx, targets, false)
	if err != nil {
		return err
	}
	if len(killed) > 0 {
		fmt.Fprintf(os.Stderr, "  ✓ Killed %d pi session(s)\n", len(killed))
	} else {
		fmt.Fprintf(os.Stderr, "  ℹ No stale pi sessions found\n")
	}
	return removeContainers(targets)
}

// pruneBuildCache removes the Docker buildx build cache.
// Safe to run unconditionally — fast when empty.
func pruneBuildCache() {
	cmd := execCommand("docker", "buildx", "prune", "-f")
	if _, err := cmd.CombinedOutput(); err == nil {
		fmt.Fprintf(os.Stderr, "  ✓ Pruned Docker build cache\n")
	}
}
