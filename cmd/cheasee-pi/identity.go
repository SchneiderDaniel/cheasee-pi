package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash/fnv"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// ──────────────────────────────────────────────
// Identity derivation (pure — no docker I/O)
//
// The container name, the codeflow sidecar name and the compose project name
// all derive from ONE identity: the bare repo's remote URL (owner/repo), with
// a fallback chain to the repo name, then the workspace folder basename.
// Distinct repos → distinct containers/projects/networks on the same host;
// the same repo in two folders keeps one container (parallel sessions share
// it, per docs/daily-usage.md).
// ──────────────────────────────────────────────

// containerName returns the daemon container name for a workspace: the repo
// slug suffixed to the service prefix, length-capped to the RFC 1034 63-char
// label limit (over-long names fail embedded-DNS resolution silently).
func containerName(workspaceRoot string) string {
	return "cheasee-pi-" + truncateSlug(repoSlug(workspaceRoot), 52)
}

// codeflowContainerName follows the same repo-slug scheme for the codeflow
// sidecar service.
func codeflowContainerName(workspaceRoot string) string {
	return "codeflow-" + truncateSlug(repoSlug(workspaceRoot), 54)
}

// composeProjectName derives the compose project name for a workspace — the
// isolation key. Compose matches containers to services via the
// com.docker.compose.project label, so a per-repo project name stops a second
// workspace's `up` from recreating the first workspace's container (the
// config-hash mismatch behind the fixed-name collision). Capped to 54 chars
// so <project>_default fits the 63-char DNS label. The charset contract is
// ^[a-z0-9][a-z0-9_-]*$ (compose ≥ v2.17) — sanitizeSlug output satisfies it.
func composeProjectName(workspaceRoot string) string {
	return "cheasee-pi-" + truncateSlug(repoSlug(workspaceRoot), 43)
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
		owner, repo := parseGitRemote(url)
		switch {
		case owner != "" && repo != "":
			return sanitizeSlug(owner + "-" + repo)
		case repo != "":
			return sanitizeSlug(repo)
		}
	}
	return sanitizeSlug(filepath.Base(workspaceRoot))
}

// bareRepoURL reads remote.origin.url from the sibling bare repo — the
// identity source for the derived names. Empty on any error (the caller falls
// back to the folder basename).
func bareRepoURL(workspaceRoot string) string {
	bare := filepath.Join(filepath.Dir(workspaceRoot), ".bare")
	cmd := execCommand("git", "--git-dir", bare, "config", "--get", "remote.origin.url")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// parseGitRemote parses a git remote URL into (owner, repo):
//
//	https://github.com/owner/repo.git   → (owner, repo)
//	git@github.com:owner/repo.git      → (owner, repo)
//	ssh://git@github.com/owner/repo    → (owner, repo)
//	https://gitlab.com/group/sub/foo   → (group/sub, foo)  (nested groups)
//
// ".git" stripped; unparseable/owner-less input → ("", repo-or-empty) so the
// caller's fallback chain can proceed.
func parseGitRemote(raw string) (owner, repo string) {
	url := strings.TrimSpace(raw)
	url = strings.TrimSuffix(url, ".git")
	if i := strings.Index(url, "://"); i >= 0 {
		// scheme://host/path — drop the scheme and the host
		url = url[i+3:]
		if j := strings.Index(url, "/"); j >= 0 {
			url = url[j+1:]
		} else {
			return "", ""
		}
	} else if i := strings.LastIndex(url, ":"); i >= 0 {
		// scp-like git@host:owner/repo — drop everything through the colon
		url = url[i+1:]
	}
	url = strings.Trim(url, "/")
	parts := strings.Split(url, "/")
	if len(parts) >= 2 && parts[len(parts)-1] != "" {
		return strings.Join(parts[:len(parts)-1], "/"), parts[len(parts)-1]
	}
	if len(parts) == 1 && parts[0] != "" {
		return "", parts[0]
	}
	return "", ""
}

// sanitizeSlug lowercases and maps non-alphanumerics to '-' so the slug is a
// valid docker container-name / compose project-name character set.
func sanitizeSlug(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

// ──────────────────────────────────────────────
// CodeFlow host port
// ──────────────────────────────────────────────

// codeflowPortBase is the low end of the derived per-repo CodeFlow port
// range; codeflowPortRange spans 1024 ports so fnv32(slug)%1024 lands in
// [8470, 9493]. Deterministic per repo → parallel workspaces get stable,
// usually-distinct ports; the probe + next-free fallback below absorbs
// birthday collisions, and CODEFLOW_PORT / docker.codeflowPort are the
// explicit escapes.
const (
	codeflowPortBase  = 8470
	codeflowPortRange = 1024
)

// portProbe checks whether a host TCP port on loopback is free to bind; a
// package-var seam so tests can simulate occupancy/exhaustion without binding
// sockets.
var portProbe = func(port int) error {
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return err
	}
	return l.Close()
}

// codeflowHostPort resolves the CodeFlow host port for a workspace:
// cheasee-settings.json docker.codeflowPort (explicit per-repo config) >
// process env CODEFLOW_PORT (the existing escape hatch, passed through
// untouched) > derived base+fnv32(repoSlug)%range, probed with next-free
// fallback. Range exhaustion fails closed with an actionable error.
func codeflowHostPort(workspaceRoot string) (string, error) {
	if s, err := LoadCheaseeSettings(workspaceRoot); err == nil && s.Docker.CodeflowPort != "" {
		return s.Docker.CodeflowPort, nil
	}
	if env := os.Getenv("CODEFLOW_PORT"); env != "" {
		return env, nil
	}
	start := codeflowPortBase + int(fnv32(repoSlug(workspaceRoot))%codeflowPortRange)
	for p := start; p < codeflowPortBase+codeflowPortRange; p++ {
		if portProbe(p) == nil {
			return strconv.Itoa(p), nil
		}
	}
	return "", fmt.Errorf("no free host port in [%d, %d] for the CodeFlow service — stop another workspace or set CODEFLOW_PORT explicitly", codeflowPortBase, codeflowPortBase+codeflowPortRange-1)
}

// fnv32 is the FNV-1a 32-bit hash used for the deterministic port offset.
func fnv32(s string) uint32 {
	h := fnv.New32a()
	h.Write([]byte(s))
	return h.Sum32()
}

// stripEnvKeys returns env minus the given KEY= entries — derived CLI values
// are authoritative, and duplicate KEY= entries resolve nondeterministically
// across libc/exec builds.
func stripEnvKeys(env []string, keys ...string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		key, _, ok := strings.Cut(kv, "=")
		if ok && slices.Contains(keys, key) {
			continue
		}
		out = append(out, kv)
	}
	return out
}
