package main

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
)

// ──────────────────────────────────────────────
// Identity derivation (pure — no docker I/O)
//
// The container name, the codeflow sidecar name, the ui name and the compose
// project name all derive from ONE identity: instanceKey — the display repo
// slug (bare repo's remote URL, with a fallback chain to the repo name, then
// the workspace folder basename) PLUS a digest of the workspace's absolute
// path.
//
// The path digest is what makes two worktrees of one repo distinct. Deriving
// from the remote alone (the pre-fix behavior) mapped every worktree of a repo
// onto one container name and one compose project, so a second worktree's
// `up` reused the first worktree's container — bound to the FIRST workspace's
// host path — and its sessions never became visible to any sidecar
// (docs/daily-usage.md). instanceKey itself lives in instance_key.go.
// ──────────────────────────────────────────────

// containerName returns the daemon container name for a workspace: the
// instance key suffixed to the service prefix, length-capped to the RFC 1034
// 63-char label limit (over-long names fail embedded-DNS resolution silently).
// The cap accounts for the 12-char "cheasee-pi-" prefix so the whole name —
// not just the slug — stays inside the limit.
func containerName(workspaceRoot string) string {
	return containerNameFromKey(instanceKey(workspaceRoot))
}

// codeflowContainerName follows the same instance-key scheme for the codeflow
// sidecar service (9-char prefix + 54 = 63).
func codeflowContainerName(workspaceRoot string) string {
	return "codeflow-" + truncateSlug(instanceKey(workspaceRoot), 54)
}

// composeProjectName derives the compose project name for a workspace — the
// isolation key. Compose matches containers to services via the
// com.docker.compose.project label, so a per-repo project name stops a second
// workspace's `up` from recreating the first workspace's container (the
// config-hash mismatch behind the fixed-name collision). Capped to 54 chars
// so <project>_default fits the 63-char DNS label. The charset contract is
// ^[a-z0-9][a-z0-9_-]*$ (compose ≥ v2.17) — sanitizeSlug output satisfies it.
func composeProjectName(workspaceRoot string) string {
	return "cheasee-pi-" + truncateSlug(instanceKey(workspaceRoot), 43)
}

// cheaseeImageRef derives the compose-built image reference for a workspace:
// compose auto-names built images <project>-<service> and the compose file's
// pi service is named `cheasee-pi`, so under the forced
// COMPOSE_PROJECT_NAME the built image is <project>-cheasee-pi. Derived from
// composeProjectName (43-char slug cap) — never containerName (52-char cap):
// over-long slugs truncate per cap and the containerName derivation would
// name the wrong image.
func cheaseeImageRef(workspaceRoot string) string {
	return composeProjectName(workspaceRoot) + "-cheasee-pi"
}

// truncateSlug caps a repo slug to max chars, appending a deterministic
// 6-hex-char sha256 suffix when truncation happens so distinct over-long
// slugs stay distinct (plain truncation would silently collide two repos
// whose names share the first max chars). Under-cap slugs pass through
// verbatim.
func truncateSlug(slug string, max int) string {
	if len(slug) <= max {
		return slug
	}
	sum := sha256.Sum256([]byte(slug))
	return slug[:max-7] + "-" + hex.EncodeToString(sum[:3])
}

// repoSlug is the docker-safe repo identity for a workspace: owner/repo from
// the sibling bare repo's remote URL when resolvable, else the repo name,
// else the workspace basename. Lowercased, non-alphanumerics → '-'.
func repoSlug(workspaceRoot string) string {
	if url := bareRepoURL(workspaceRoot); url != "" {
		owner, repo, _ := parseGitRemote(url)
		switch {
		case owner != "" && repo != "":
			return sanitizeSlug(owner + "-" + repo)
		case repo != "":
			return sanitizeSlug(repo)
		}
	}
	return sanitizeSlug(filepath.Base(workspaceRoot))
}
