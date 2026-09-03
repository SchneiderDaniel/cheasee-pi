package main

import (
	"context"
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

// bareRepoURL reads remote.origin.url from the sibling bare repo — the
// identity source for the derived names. Empty on any error (the caller falls
// back to the folder basename).
func bareRepoURL(workspaceRoot string) string {
	bare := filepath.Join(filepath.Dir(workspaceRoot), ".bare")
	out, err := runCommandContext(context.Background(), "git", "--git-dir", bare, "config", "--get", "remote.origin.url").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// parseGitRemote parses a git remote URL into (owner, repo, host) following
// git-clone(1) URL grammar — scheme (`://`) first, scp-like only when no
// slash precedes the FIRST colon (else the input is a local path, where a
// colon keeps its path meaning), else shorthand/local:
//
//	https://github.com/owner/repo.git   → (owner, repo, github.com)
//	git@github.com:owner/repo.git      → (owner, repo, github.com)
//	ssh://git@github.com/owner/repo    → (owner, repo, github.com)
//	https://gitlab.com/group/sub/foo   → (group/sub, foo, gitlab.com)
//	owner/repo                         → (owner, repo, "")     (shorthand)
//	not-a-url                          → ("", not-a-url, "")  (ownerless)
//	file://localhost/tmp/project       → ("", "", "")          (local path)
//
// host is the lowercased authority minus userinfo and :port ("" for
// shorthand/local input). ".git" and trailing slashes are stripped in a
// canonical order (slashes first, so "repo.git/" cleans up fully); a scheme
// or scp-like URL with an EMPTY authority (https:///owner/repo, :owner/repo)
// is malformed and yields ("","","") so the init gates refuse it, while an
// unparseable/owner-less input yields a repo-or-empty pair so the caller's
// fallback chain can proceed.
func parseGitRemote(raw string) (owner, repo, host string) {
	url := strings.TrimSpace(raw)
	// Canonical strip: trailing slashes before ".git", repeated until stable
	// ("repo.git/" → "repo", "repo/.git/" → "repo").
	for {
		next := strings.TrimRight(url, "/")
		next = strings.TrimSuffix(next, ".git")
		if next == url {
			break
		}
		url = next
	}

	if strings.HasPrefix(url, "file://") {
		// file:// URLs are local paths, not remotes — git clones them from
		// the local filesystem without touching a host, so they carry no
		// owner/repo. Return the empty tuple before the generic scheme
		// branch (which would otherwise treat "localhost" or any authority
		// as a remote host and fabricate tmp/project from the path):
		// repoSlug keeps its basename fallback, the init gates refuse.
		return "", "", ""
	}

	path := url
	if i := strings.Index(url, "://"); i >= 0 {
		// scheme://[user@]host[:port]/path — drop the scheme, keep the path
		host = url[i+3:]
		if j := strings.Index(host, "/"); j >= 0 {
			host, path = host[:j], host[j+1:]
		} else {
			return "", "", "" // scheme://host with no path — nothing to split
		}
		host = authorityHost(host)
		if host == "" {
			// scheme URL with no authority (https:///owner/repo) is malformed
			// — refuse rather than hand the init gates a shorthand-looking
			// pair that would reach git.
			return "", "", ""
		}
	} else if i := strings.Index(url, ":"); i >= 0 && !strings.Contains(url[:i], "/") {
		// scp-like [user@]host:path — only when no slash precedes the first
		// colon (git-clone(1) disambiguates local paths containing colons)
		// and the authority is non-empty (":owner/repo" is not scp-like).
		host = authorityHost(url[:i])
		if host == "" {
			return "", "", ""
		}
		path = url[i+1:]
	} else if strings.Contains(url, ":") {
		// No scheme and a slash before the first colon → local path with a
		// colon, not a remote: ownerless and repo-less (repoSlug falls back
		// to the workspace basename, the init gate refuses).
		return "", "", ""
	} else if strings.HasPrefix(url, "./") || strings.HasPrefix(url, "../") || strings.HasPrefix(url, "/") || strings.HasPrefix(url, "~/") || url == "." || url == ".." {
		// Relative or absolute local path (./repo, ../repo, /tmp/repo, ~/repo)
		// — git can clone it but it carries no owner/repo. Return the empty
		// tuple so repoSlug keeps its basename fallback and the init gates
		// refuse instead of fabricating a GitHub URL like https://github.com/./repo.git.
		return "", "", ""
	}

	parts := strings.Split(path, "/")
	if len(parts) >= 2 && parts[len(parts)-1] != "" {
		return strings.Join(parts[:len(parts)-1], "/"), parts[len(parts)-1], host
	}
	if len(parts) == 1 && parts[0] != "" {
		return "", parts[0], host
	}
	return "", "", host
}

// authorityHost normalizes a URL authority to the bare lowercased host:
// userinfo ("git@") and any :port are stripped.
func authorityHost(authority string) string {
	host := authority
	if at := strings.LastIndex(host, "@"); at >= 0 {
		host = host[at+1:]
	}
	if colon := strings.Index(host, ":"); colon >= 0 {
		host = host[:colon]
	}
	return strings.ToLower(host)
}

// parseGitHubRemote is the GitHub-only acceptance gate for the init call
// sites (canonicalRepoURL, canonicalSkillRepo): parseGitRemote must yield
// non-empty owner+repo, the host must be shorthand-empty or github.com
// (parseGitRemote lowercases, so the match is case-insensitive), and the
// owner must be a single segment — GitHub paths are exactly owner/repo, so
// any multi-segment owner (nested groups, /tree/main refs) is refused here
// instead of failing late inside git.
func parseGitHubRemote(raw string) (owner, repo string) {
	owner, repo, host := parseGitRemote(raw)
	if owner == "" || repo == "" {
		return "", ""
	}
	if host != "" && host != "github.com" {
		return "", ""
	}
	if strings.Contains(owner, "/") {
		return "", ""
	}
	return owner, repo
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
