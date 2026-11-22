package main

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
)

// ──────────────────────────────────────────────
// Per-workspace instance identity (pure — no docker I/O)
//
// instanceKey is the ONE identity every derived docker name is built from:
// the display repo slug plus a digest of the workspace's absolute path. It
// lives next to the name derivations (identity.go) but in its own module
// because the path digest — not the remote — is what separates two worktrees
// of one repo, and the god-object ceiling keeps one responsibility per file.
// ──────────────────────────────────────────────

// instanceKey is the per-workspace instance identity: the display repo slug
// plus the first 8 hex characters of sha256 over the workspace's absolute
// path. Two worktrees of one repo share the slug but never the path, so they
// get distinct container names, compose projects and derived ports — which is
// what lets a sidecar see (and a second `up` not hijack) each of them.
//
// Path normalization (Abs + Clean) happens before hashing so lexical variants
// of the same folder — a trailing slash, an embedded /./ or /…/ segment —
// resolve to one identity instead of looking like a second instance. The key
// stays docker-safe because the slug prefix is sanitizeSlug output and the
// suffix is lowercase hex.
func instanceKey(workspaceRoot string) string {
	path := instancePath(workspaceRoot)
	slug := repoSlug(path)
	if slug == "" {
		// A folder name with no alphanumeric character sanitizes to "": the
		// key must still be docker-safe, never start with a separator.
		slug = "workspace"
	}
	sum := sha256.Sum256([]byte(path))
	return slug + "-" + hex.EncodeToString(sum[:4])
}

// instancePath is the identity input: the workspace absolute path, cleaned.
// An Abs failure falls back to the cleaned input (deterministic either way — a
// relative path only arises from a caller that never resolved the workdir).
func instancePath(workspaceRoot string) string {
	abs, err := filepath.Abs(workspaceRoot)
	if err != nil {
		abs = workspaceRoot
	}
	return filepath.Clean(abs)
}

// containerNameFromKey maps an instance key onto its agent container name. The
// registry snapshot needs it because a record deliberately stores no docker
// object. The 51-char cap keeps the whole 12-char-prefixed name inside the
// RFC 1034 63-char label limit.
func containerNameFromKey(key string) string {
	return "cheasee-pi-" + truncateSlug(key, 51)
}

// instanceLabel is the peer-facing display name: the repo slug plus the
// worktree folder name. It never carries a host path — every sidecar on the
// host can read the published snapshot.
func instanceLabel(workspaceRoot string) string {
	slug := repoSlug(workspaceRoot)
	if slug == "" {
		slug = "workspace"
	}
	base := filepath.Base(filepath.Clean(workspaceRoot))
	if base == "" || base == slug || base == "." || base == string(filepath.Separator) {
		return slug
	}
	return slug + " (" + base + ")"
}
