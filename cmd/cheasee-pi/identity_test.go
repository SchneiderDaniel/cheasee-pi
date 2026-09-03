package main

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// writeBareRemote makes the sibling .bare a real bare repo with the given
// remote.origin.url, so repoSlug/containerName/composeProjectName derive from
// a genuine git remote identity (read via the real git binary — no seam).
func writeBareRemote(t *testing.T, parent, url string) {
	t.Helper()
	bare := filepath.Join(parent, ".bare")
	runGit(t, "init", "--bare", "-q", bare)
	runGit(t, "--git-dir", bare, "config", "remote.origin.url", url)
}

// ──────────────────────────────────────────────
// parseGitRemote / parseGitHubRemote (entity)
// ──────────────────────────────────────────────

func TestParseGitRemote(t *testing.T) {
	// Union of the old TestParseGitHubURL + TestParseGitRemote_variants
	// tables, plus the divergence rows pinning the merged semantics
	// (3-tuple asserts: owner, repo, host).
	cases := []struct{ raw, owner, repo, host string }{
		// shorthand
		{"alice/foo", "alice", "foo", ""},
		{"owner/repo.git", "owner", "repo", ""},
		{"alice/foo/", "alice", "foo", ""},
		// https
		{"https://github.com/alice/foo.git", "alice", "foo", "github.com"},
		{"https://github.com/alice/foo", "alice", "foo", "github.com"},
		{"https://github.com/owner/repo/", "owner", "repo", "github.com"},
		// canonical strip order fixes .git + trailing slash
		{"https://github.com/owner/repo.git/", "owner", "repo", "github.com"},
		// ssh colon (scp-like)
		{"git@github.com:alice/foo.git", "alice", "foo", "github.com"},
		{"git@github.com:alice/foo", "alice", "foo", "github.com"},
		// ssh scheme; userinfo and :port stripped from the host
		{"ssh://git@github.com/alice/foo.git", "alice", "foo", "github.com"},
		{"ssh://git@github.com:2222/owner/repo", "owner", "repo", "github.com"},
		// git:// kept from the old table (dead on GitHub, not rejected here)
		{"git://github.com/alice/foo.git", "alice", "foo", "github.com"},
		// host lowercased (kills the old case-sensitive anchor bug)
		{"https://GitHub.com/owner/repo", "owner", "repo", "github.com"},
		{"git@GitHub.com:owner/repo", "owner", "repo", "github.com"},
		// nested groups (GitLab) — all-but-last-segment owner
		{"https://gitlab.com/group/sub/foo.git", "group/sub", "foo", "gitlab.com"},
		{"https://gitlab.com/a/b", "a", "b", "gitlab.com"},
		{"git@gitlab.com:group/sub/foo.git", "group/sub", "foo", "gitlab.com"},
		// deep GitHub URL — no silent segment-drop (old SplitN("/", 3))
		{"https://github.com/o/r/tree/main", "o/r/tree", "main", "github.com"},
		// form order (git-clone(1)): scp-like only when no slash precedes
		// the FIRST colon
		{"host:2222:o/r", "2222:o", "r", "host"},
		{"foo/bar:baz", "", "", ""}, // local-path-with-colon → ownerless
		// empty authorities are malformed — never shorthand (kills the
		// audit finding: a scheme/scp URL with no host must fail closed)
		{"https:///owner/repo", "", "", ""},
		{"https://:2222/owner/repo", "", "", ""},
		{":owner/repo", "", "", ""},
		{"@:owner/repo", "", "", ""},
		// reject semantic: single-segment ownerless keeps the repo
		{"not-a-url", "", "not-a-url", ""},
		{"alice", "", "alice", ""},
		// relative/absolute local paths — git can clone them but they carry
		// no owner/repo; empty tuple keeps repoSlug's basename fallback and
		// makes the init gates refuse (never github.com/./repo.git)
		{"./repo", "", "", ""},
		{"../repo", "", "", ""},
		{"/tmp/abs/repo", "", "", ""},
		{"~/repo", "", "", ""},
		// file:// URLs are local paths too — the authority is a filesystem
		// location, never a remote host (kills the audit finding: "localhost"
		// must not become a host with owner tmp/repo project)
		{"file://localhost/tmp/project.git", "", "", ""},
		{"file:///tmp/project.git", "", "", ""},
		{"file://server/share/repo", "", "", ""},
		// empty / whitespace
		{"", "", "", ""},
		{"   ", "", "", ""},
	}
	for _, c := range cases {
		owner, repo, host := parseGitRemote(c.raw)
		if owner != c.owner || repo != c.repo || host != c.host {
			t.Errorf("parseGitRemote(%q) = (%q, %q, %q), want (%q, %q, %q)", c.raw, owner, repo, host, c.owner, c.repo, c.host)
		}
	}
}

func TestParseGitHubRemote(t *testing.T) {
	accepted := []struct{ raw, owner, repo string }{
		{"owner/repo", "owner", "repo"},
		{"owner/repo.git", "owner", "repo"},
		{"https://github.com/o/r", "o", "r"},
		{"https://github.com/o/r.git", "o", "r"},
		{"https://github.com/o/r/", "o", "r"},
		{"ssh://git@github.com/o/r", "o", "r"},
		{"git@github.com:o/r", "o", "r"},
		{"https://GitHub.com/o/r", "o", "r"}, // host lowercased by the parser
	}
	for _, c := range accepted {
		owner, repo := parseGitHubRemote(c.raw)
		if owner != c.owner || repo != c.repo {
			t.Errorf("parseGitHubRemote(%q) = (%q, %q), want (%q, %q)", c.raw, owner, repo, c.owner, c.repo)
		}
	}

	refused := []string{
		"https://gitlab.com/a/b",
		"git@gitlab.com:a/b",
		"https://github.com/o/r/tree/main", // multi-segment owner
		"https:///owner/repo",              // scheme with no authority
		":owner/repo",                      // scp-like with no authority
		"alice",                            // ownerless
		"not-a-url",
		"",
		"foo/bar:baz", // local-path-with-colon
		"./repo",       // relative local path (never github.com/./repo)
		"../repo",      // relative local path
		"file://localhost/tmp/project.git", // file URL → local path, not a host
	}
	for _, raw := range refused {
		if owner, repo := parseGitHubRemote(raw); owner != "" || repo != "" {
			t.Errorf("parseGitHubRemote(%q) = (%q, %q), want (\"\", \"\")", raw, owner, repo)
		}
	}
}

// ──────────────────────────────────────────────
// sanitizeSlug (entity)
// ──────────────────────────────────────────────

func TestSanitizeSlug(t *testing.T) {
	cases := []struct{ in, want string }{
		{"My.Repo", "my-repo"},
		{"-repo-", "repo"},
		{"ALICE/foo", "alice-foo"},
		{"répo", "r-po"},
		{"a__b", "a--b"},
		{"", ""},
	}
	for _, c := range cases {
		if got := sanitizeSlug(c.in); got != c.want {
			t.Errorf("sanitizeSlug(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ──────────────────────────────────────────────
// truncateSlug (entity)
// ──────────────────────────────────────────────

func TestTruncateSlug_underCapUnchanged(t *testing.T) {
	if got := truncateSlug("alice-foo", 52); got != "alice-foo" {
		t.Errorf("short slug must pass through, got %q", got)
	}
}

func TestTruncateSlug_atCapUnchanged(t *testing.T) {
	slug := strings.Repeat("a", 52)
	if got := truncateSlug(slug, 52); got != slug {
		t.Errorf("at-cap slug must pass through, got %q (len %d)", got, len(got))
	}
}

func TestTruncateSlug_overCapDeterministicAndCapped(t *testing.T) {
	long := strings.Repeat("a", 60) + "x"
	a := truncateSlug(long, 52)
	b := truncateSlug(long, 52)
	if a != b {
		t.Errorf("truncation must be deterministic: %q vs %q", a, b)
	}
	if len(a) > 52 {
		t.Errorf("truncated slug must be ≤ %d chars, got %d", 52, len(a))
	}
	if len(a) == 0 {
		t.Error("truncated slug must never be empty")
	}
}

func TestTruncateSlug_distinctOverCapSlugsStayDistinct(t *testing.T) {
	s1 := strings.Repeat("a", 60) + "x"
	s2 := strings.Repeat("a", 60) + "y"
	if truncateSlug(s1, 52) == truncateSlug(s2, 52) {
		t.Error("hash suffix must keep over-cap slugs distinct")
	}
}

// ──────────────────────────────────────────────
// containerName / codeflowContainerName / composeProjectName
// ──────────────────────────────────────────────

func TestDerivedNames_lengthCapped(t *testing.T) {
	root := filepath.Join(t.TempDir(), strings.Repeat("x", 100))
	if got := containerName(root); len(got) > 63 {
		t.Errorf("containerName must be ≤63 chars (RFC 1034 label), got %d: %q", len(got), got)
	}
	if got := codeflowContainerName(root); len(got) > 63 {
		t.Errorf("codeflowContainerName must be ≤63 chars, got %d: %q", len(got), got)
	}
	if got := composeProjectName(root); len(got) > 54 {
		t.Errorf("composeProjectName must be ≤54 chars (<project>_default ≤63), got %d: %q", len(got), got)
	}
}

var composeNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

func TestComposeProjectName_charset(t *testing.T) {
	parent := t.TempDir()
	for _, base := range []string{"My.Repo", "-repo-", "répo", "  spaces  ", "UPPER"} {
		root := filepath.Join(parent, base)
		got := composeProjectName(root)
		if !composeNameRe.MatchString(got) {
			t.Errorf("composeProjectName(%q) = %q fails ^[a-z0-9][a-z0-9_-]*$ (compose ≥v2.17)", base, got)
		}
	}
}

func TestDerivedNames_ownerRepoIdentity(t *testing.T) {
	// alice/foo vs bob/foo → distinct identities (owner matters, not just the
	// repo name); the same repo in two folders → one shared identity.
	parentA, rootA := mkWorkspace(t, `{}`)
	writeBareRemote(t, parentA, "https://github.com/alice/foo.git")
	parentB, rootB := mkWorkspace(t, `{}`)
	writeBareRemote(t, parentB, "https://github.com/bob/foo.git")
	parentC, rootC := mkWorkspace(t, `{}`)
	writeBareRemote(t, parentC, "https://github.com/alice/foo.git")

	if containerName(rootA) == containerName(rootB) {
		t.Error("alice/foo and bob/foo must get distinct containers")
	}
	if composeProjectName(rootA) == composeProjectName(rootB) {
		t.Error("alice/foo and bob/foo must get distinct compose projects")
	}
	if containerName(rootA) != containerName(rootC) {
		t.Error("same repo in two folders must share one container identity")
	}
	if composeProjectName(rootA) != composeProjectName(rootC) {
		t.Error("same repo in two folders must share one project identity")
	}
	if containerName(rootA) != "cheasee-pi-alice-foo" {
		t.Errorf("containerName = %q, want cheasee-pi-alice-foo", containerName(rootA))
	}
}

func TestDerivedNames_fallbackToBasename(t *testing.T) {
	// No .bare remote → workspace basename drives the identity.
	_, root := mkWorkspace(t, `{}`) // root = <parent>/ws
	if got := containerName(root); got != "cheasee-pi-ws" {
		t.Errorf("containerName = %q, want cheasee-pi-ws", got)
	}
	if got := codeflowContainerName(root); got != "codeflow-ws" {
		t.Errorf("codeflowContainerName = %q, want codeflow-ws", got)
	}
	if got := composeProjectName(root); got != "cheasee-pi-ws" {
		t.Errorf("composeProjectName = %q, want cheasee-pi-ws", got)
	}
}

func TestRepoSlug_scpLikeRemote(t *testing.T) {
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "git@github.com:alice/foo.git")
	if got := repoSlug(root); got != "alice-foo" {
		t.Errorf("repoSlug = %q, want alice-foo", got)
	}
}

func TestRepoSlug_fileURLFallsBackToBasename(t *testing.T) {
	// A file:// remote is a local path, not a remote identity: deriving
	// tmp/project from the URL's pseudo-host "localhost" would rename the
	// workspace after an unrelated path. repoSlug must fall back to the
	// workspace basename instead.
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "file://localhost/tmp/project.git")
	if got := repoSlug(root); got != filepath.Base(root) {
		t.Errorf("repoSlug = %q, want basename %q", got, filepath.Base(root))
	}
}

// ──────────────────────────────────────────────
// codeflowHostPort (entity + use-case, probe stubbed)
// ──────────────────────────────────────────────

func TestCodeflowHostPort_derivedDeterministicInRange(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ws")
	p1, err := codeflowHostPort(root)
	if err != nil {
		t.Fatalf("codeflowHostPort: %v", err)
	}
	p2, err := codeflowHostPort(root)
	if err != nil {
		t.Fatal(err)
	}
	if p1 != p2 {
		t.Errorf("derived port must be deterministic per repo: %s vs %s", p1, p2)
	}
	n, err := strconv.Atoi(p1)
	if err != nil || n < 8470 || n > 9493 {
		t.Errorf("derived port must be in [8470, 9493], got %q", p1)
	}
}

func TestCodeflowHostPort_twoRootsDistinctPorts(t *testing.T) {
	// Fixed slugs whose fnv32-derived ports differ (verified: 484 vs 50).
	rootA := filepath.Join(t.TempDir(), "repo-alpha")
	rootB := filepath.Join(t.TempDir(), "repo-beta")
	pa, err := codeflowHostPort(rootA)
	if err != nil {
		t.Fatal(err)
	}
	pb, err := codeflowHostPort(rootB)
	if err != nil {
		t.Fatal(err)
	}
	if pa == pb {
		t.Errorf("two distinct repos must resolve to distinct ports, both %s", pa)
	}
}

func TestCodeflowHostPort_envOverrideWins(t *testing.T) {
	t.Setenv("CODEFLOW_PORT", "9000")
	got, err := codeflowHostPort(filepath.Join(t.TempDir(), "ws"))
	if err != nil {
		t.Fatal(err)
	}
	if got != "9000" {
		t.Errorf("env CODEFLOW_PORT must win over derivation, got %s", got)
	}
}

func TestCodeflowHostPort_settingsWinsOverEnv(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"docker": {"codeflowPort": "9100"}}`)
	t.Setenv("CODEFLOW_PORT", "9000")
	got, err := codeflowHostPort(workdir)
	if err != nil {
		t.Fatal(err)
	}
	if got != "9100" {
		t.Errorf("settings docker.codeflowPort must win over env, got %s", got)
	}
}

func TestCodeflowHostPort_occupiedFallsBackToNextFree(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ws")
	start := codeflowPortBase + int(fnv32(repoSlug(root))%codeflowPortRange)
	if start == codeflowPortBase+codeflowPortRange-1 {
		t.Skip("derived port at range end — no fallback slot; covered by exhaustion test")
	}
	saved := portProbe
	portProbe = func(p int) error {
		if p == start {
			return fmt.Errorf("in use")
		}
		return nil
	}
	t.Cleanup(func() { portProbe = saved })

	got, err := codeflowHostPort(root)
	if err != nil {
		t.Fatal(err)
	}
	n, _ := strconv.Atoi(got)
	if n != start+1 {
		t.Errorf("occupied derived port must fall back to the next free (%d), got %d", start+1, n)
	}
}

func TestCodeflowHostPort_rangeExhaustedFailsClosed(t *testing.T) {
	saved := portProbe
	portProbe = func(p int) error { return fmt.Errorf("in use") }
	t.Cleanup(func() { portProbe = saved })

	_, err := codeflowHostPort(filepath.Join(t.TempDir(), "ws"))
	if err == nil {
		t.Fatal("range exhaustion must fail closed with an error")
	}
	if !strings.Contains(err.Error(), "CODEFLOW_PORT") {
		t.Errorf("error must name the remedy (CODEFLOW_PORT), got %v", err)
	}
}

// ──────────────────────────────────────────────
// stripEnvKeys (env hygiene for the derived identity)
// ──────────────────────────────────────────────

func TestStripEnvKeys(t *testing.T) {
	env := []string{"A=1", "B=2", "A=3", "C=4"}
	got := stripEnvKeys(env, "A")
	want := []string{"B=2", "C=4"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("stripEnvKeys(env, A) = %v, want %v", got, want)
	}
	if len(stripEnvKeys(env, "A", "B", "C")) != 0 {
		t.Errorf("stripping all keys must empty the env, got %v", stripEnvKeys(env, "A", "B", "C"))
	}
}
