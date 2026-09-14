package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

var pruneImagesDryRun bool
var pruneImagesYes bool

// pruneImagesConfirmFn is the y/N gate before removing tagged images;
// overridable in tests. Abort (false) leaves every image untouched.
var pruneImagesConfirmFn = promptConfirm

var pruneImagesCmd = &cobra.Command{
	Use:   "prune-images",
	Short: "Delete ALL tagged cheasee-pi images (every repo) — recreated on next build",
	Long: `Remove every tagged cheasee-pi Docker image on the host and reclaim the
build cache they pin — the explicit "free the disk" step when repeated
builds fill the Docker data root.

Each repository build produces one ~GB tagged image (compose names it
cheasee-pi-<slug>-<service>) and nothing removes them: 'cheasee-pi clean'
only prunes dangling images and build cache, so the tagged images accumulate
forever and keep the build cache "in use". prune-images enumerates ALL
tagged cheasee-pi-* images on the host (every repository, no keep-latest —
images are regenerable via 'cheasee-pi build' / 'cheasee-pi rebuild'),
force-removes each by full Repository:Tag, then prunes dangling images and
the build cache.

prune-images refuses while any cheasee-pi container exists (running or
stopped): -f cannot remove the image of a running container (hard Docker
conflict) and force-removing a stopped container's image silently orphans it
("No such image" on next start). Run 'cheasee-pi clean' first — clean
removes containers, prune-images removes the tagged images.

WARNING: 'docker buildx prune -a' discards build cache host-wide — other
projects sharing the default builder lose their cache too.

Before removing anything, prune-images lists the matched images with
approximate (upper-bound) sizes and asks for confirmation. --yes skips the
prompt, --dry-run only shows what would be removed.

Examples:
  cheasee-pi prune-images               # preview, confirm, then remove all tagged images + prune cache
  cheasee-pi prune-images --dry-run     # show what would be removed, touch nothing
  cheasee-pi prune-images --yes         # skip the confirmation prompt`,
	DisableAutoGenTag: true,
	RunE:              runPruneImagesE,
}

func init() {
	rootCmd.AddCommand(pruneImagesCmd)
	pruneImagesCmd.Flags().BoolVar(&pruneImagesDryRun, "dry-run", false, "List the tagged images that would be removed without touching anything")
	pruneImagesCmd.Flags().BoolVar(&pruneImagesYes, "yes", false, "Skip the confirmation prompt")
}

// pruneImagesPrompt builds the confirmation question for the preview pass.
// It discloses both the image count and the host-wide build-cache blast
// radius before consent.
func pruneImagesPrompt(count int) string {
	return fmt.Sprintf("Remove %d tagged cheasee-pi image(s) and prune the host-wide build cache?", count)
}

func runPruneImagesE(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}

	// Fail-closed gate: force-removing an image a container references either
	// fails hard (running container — a conflict -f cannot force, leaving a
	// partial mid-loop deletion) or silently orphans the container (stopped —
	// "No such image" on next start). Both states are defined away by refusing
	// to run while ANY managed container exists; --yes never bypasses this.
	containers, err := listManagedContainers(ctx)
	if err != nil {
		return fmt.Errorf("prune-images: enumerate containers: %w", err)
	}
	if len(containers) > 0 {
		return fmt.Errorf("prune-images: %d cheasee-pi container(s) still exist (%s) — run `cheasee-pi clean` first",
			len(containers), strings.Join(containers, ", "))
	}

	images, err := listCheaseePiImages(ctx)
	if err != nil {
		return fmt.Errorf("prune-images: enumerate images: %w", err)
	}

	if pruneImagesDryRun {
		if len(images) == 0 {
			fmt.Fprintf(os.Stderr, "  ℹ No cheasee-pi images found\n")
		} else {
			fmt.Fprintf(os.Stderr, "  ℹ Would remove %d image(s):\n", len(images))
			for _, img := range images {
				// SIZE is cumulative across shared parent layers — an upper
				// bound, so it is labeled approximate.
				fmt.Fprintf(os.Stderr, "    %s  (≈ %s)\n", img.Ref, img.Size)
			}
		}
		fmt.Fprintf(os.Stderr, "  ℹ Dry-run: nothing removed, no cache pruned\n")
		return nil
	}

	if !pruneImagesYes {
		ok, err := pruneImagesConfirmFn(pruneImagesPrompt(len(images)))
		if err != nil {
			return fmt.Errorf("prune-images: %w", err)
		}
		if !ok {
			fmt.Fprintf(os.Stderr, "  ✗ Aborted — no images removed\n")
			return nil
		}
	}

	if err := removeImages(ctx, images); err != nil {
		return fmt.Errorf("prune-images: %w", err)
	}
	// The tagged images pinned the build cache; only after they are gone does
	// the cache become reclaimable. Order matters — prune the images first.
	// Failures surface: the tagged images may be gone but the disk pressure
	// they caused is not, and silence would hide that.
	if err := pruneOrphanedImages(ctx); err != nil {
		return fmt.Errorf("prune-images: %w", err)
	}
	if err := pruneAllBuildCache(ctx); err != nil {
		return fmt.Errorf("prune-images: %w", err)
	}
	return nil
}
