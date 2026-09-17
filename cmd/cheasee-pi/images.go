package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// imageNamePrefix is the single source of truth for what counts as a
// cheasee-pi image: compose auto-names built images <project>-<service> and
// applyComposeEnv forces COMPOSE_PROJECT_NAME=cheasee-pi-<slug>, so every
// image the CLI produces — cheasee-pi-<slug>-cheasee-pi and
// cheasee-pi-<slug>-codeflow (legacy ones cheasee-pi-cheasee-pi /
// cheasee-pi-codeflow) — starts with this prefix. One constant feeds both the
// daemon reference= filter and the Go post-filter, so they can never drift
// apart.
const imageNamePrefix = "cheasee-pi-"

// cheaseePiImage is one tagged image owned by the CLI. Ref is the full
// Repository:Tag — the only rm-able identity: the same image ID under two
// tags must never be deduped, or the second rm re-fails with "tagged in
// multiple repositories".
type cheaseePiImage struct {
	Ref  string
	Size string // daemon SIZE string; cumulative across shared parent layers (upper bound)
}

// isCheaseePiImageRef reports whether a full Repository:Tag reference is one
// of ours. Like isLegacyContainerName, the prefix is a convention, not a
// marker: a foreign image literally named cheasee-pi-* is matched — the
// post-filter only guarantees the daemon's substring-ish reference filter is
// a complete prefix match, it cannot distinguish CLI images from look-alikes.
func isCheaseePiImageRef(ref string) bool {
	return strings.HasPrefix(ref, imageNamePrefix)
}

// imageExists reports whether a tagged image reference exists on the host,
// via `docker image inspect <ref>`: exit 0 → true, exit 1 (no such image —
// the docker CLI's missing-image convention) → false, any other non-zero
// exit → wrapped error. Fail-closed: a daemon failure is never treated as
// "missing" (the Phase-2 docker check already ran, so the error is real).
func imageExists(ctx context.Context, ref string) (bool, error) {
	if _, err := runCommandContext(ctx, "docker", "image", "inspect", ref).Output(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return false, nil
		}
		return false, fmt.Errorf("docker image inspect %s: %w", ref, err)
	}
	return true, nil
}

// listCheaseePiImages enumerates every tagged cheasee-pi image on the host.
// The daemon reference= filter pre-scopes the listing; the Go post-filter
// keeps the scope honest. Dangling images have no references and never
// appear. A docker failure is surfaced — never an empty-slice-as-success.
func listCheaseePiImages(ctx context.Context) ([]cheaseePiImage, error) {
	out, err := runCommandContext(ctx, "docker", "image", "ls",
		"--filter", "reference="+imageNamePrefix+"*",
		"--format", "{{.Repository}}:{{.Tag}}|{{.Size}}").Output()
	if err != nil {
		return nil, fmt.Errorf("docker image ls: %w", err)
	}
	var images []cheaseePiImage
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line == "" {
			continue
		}
		ref, size, ok := strings.Cut(line, "|")
		if !ok || !isCheaseePiImageRef(ref) {
			continue
		}
		images = append(images, cheaseePiImage{Ref: ref, Size: size})
	}
	return images, nil
}

// removeImages force-removes each image by full Repository:Tag. A failed rm
// aborts naming the ref — never a silent partial removal. Re-running after a
// partial run is idempotent: entries already gone error, but the enumeration
// only yields refs that existed at scan time.
func removeImages(ctx context.Context, images []cheaseePiImage) error {
	for _, img := range images {
		if _, err := runCommandContext(ctx, "docker", "image", "rm", "-f", img.Ref).CombinedOutput(); err != nil {
			return fmt.Errorf("remove image %s: %w", img.Ref, err)
		}
		fmt.Fprintf(os.Stderr, "  ✓ Removed image %s\n", img.Ref)
	}
	return nil
}

// pruneOrphanedImages runs `docker image prune -f` so images left dangling by
// the removals are reclaimed. Safe to run unconditionally — fast when empty.
// A docker failure surfaces as an error: silence would report success while
// the unsafe/untagged artifacts stay on disk.
func pruneOrphanedImages(ctx context.Context) error {
	if _, err := runCommandContext(ctx, "docker", "image", "prune", "-f").CombinedOutput(); err != nil {
		return fmt.Errorf("docker image prune: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Pruned dangling Docker images\n")
	return nil
}
