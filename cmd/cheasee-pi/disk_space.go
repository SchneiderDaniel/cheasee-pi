package main

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// minBuildFreeBytes is the free-space floor a build requires on the Docker
// data root. The image layers, the build cache and the export scratch all
// land there; below this a build fills the partition and the daemon starts
// reclaiming images, containers and cache on its own to finish the export.
// Documented in docs/installation.md — keep the two in sync.
const minBuildFreeBytes int64 = 10 << 30 // 10 GiB

// statfsFn probes the free bytes available on the filesystem containing path.
// Test seam mirroring runCommandContext; production default is the
// build-tagged platformFreeBytes. Package has zero t.Parallel() tests, so the
// swap is race-free.
var statfsFn = platformFreeBytes

// checkBuildDiskSpace refuses a build when the Docker data root has less than
// minBuildFreeBytes free, with the recovery commands in the message. When the
// free space is undeterminable (no data root, no statfs — Docker Desktop runs
// the data root inside a VM), it fails open with a stderr warning: a probe
// that cannot see the real disk must never block a build.
func checkBuildDiskSpace(ctx context.Context) error {
	root, err := dockerDataRoot(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ Cannot determine the Docker data root (%v) — skipping the build free-space check\n", err)
		return nil
	}
	free, err := statfsFn(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ Cannot determine free space under %s (%v) — skipping the build free-space check\n", root, err)
		return nil
	}
	if free >= uint64(minBuildFreeBytes) {
		return nil
	}
	return fmt.Errorf(
		"not enough free space for a build: %.1f GiB free on the Docker data root %s, %.0f GiB required — reclaim with `cheasee-pi clean` and `cheasee-pi prune-images`, then retry",
		float64(free)/(1<<30), root, float64(minBuildFreeBytes)/(1<<30),
	)
}

// dockerDataRoot resolves the Docker data root via the daemon. An empty field
// (daemon without the key) is an error, so the caller fails open rather than
// statfs-ing an empty path.
func dockerDataRoot(ctx context.Context) (string, error) {
	out, err := runCommandContext(ctx, "docker", "info", "--format", "{{.DockerRootDir}}").Output()
	if err != nil {
		return "", fmt.Errorf("docker info: %w", err)
	}
	root := strings.TrimSpace(string(out))
	if root == "" {
		return "", fmt.Errorf("docker info returned an empty DockerRootDir")
	}
	return root, nil
}
