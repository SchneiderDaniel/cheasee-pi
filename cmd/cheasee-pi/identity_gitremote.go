package main

import (
	"context"
	"path/filepath"
	"strings"
)

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
