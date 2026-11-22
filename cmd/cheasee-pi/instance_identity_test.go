package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// Phase 1: path-keyed instance identity (entity)
//
// The reported bug: four Cheasee-Pi instances on one host were invisible to
// each other because the docker identity was derived from the git REMOTE
// only. Every worktree of one repo therefore shared one container name, one
// compose project and one derived port — a second worktree's `up` reused the
// first worktree's container (and its workspace mount), so its claims never
// appeared in the sidecar. The identity must be per workspace PATH.
// ──────────────────────────────────────────────

// instanceKeyPattern is the docker/compose charset contract: lowercase
// alphanumerics plus '-'/'_', never a leading separator (compose ≥ v2.17
// rejects anything else, and a leading '-' reads as a flag to docker).
var instanceKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

// discoverySiblings builds n sibling worktree roots under ONE parent whose
// sibling .bare carries the given remote — the shape of several checkouts of
// one repo on one host (the reported setup). An empty url leaves the sibling
// .bare uninitialized (no resolvable remote).
func discoverySiblings(t *testing.T, n int, url string) (parent string, roots []string) {
	t.Helper()
	parent = t.TempDir()
	if err := os.MkdirAll(filepath.Join(parent, ".bare"), 0o755); err != nil {
		t.Fatalf("create sibling .bare: %v", err)
	}
	for i := 1; i <= n; i++ {
		root := filepath.Join(parent, fmt.Sprintf("ws%d", i))
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatalf("create worktree %s: %v", root, err)
		}
		testutil.WriteCheaseeSettingsFile(t, root, `{}`)
		roots = append(roots, root)
	}
	if url != "" {
		writeBareRemote(t, parent, url)
	}
	return parent, roots
}

func TestDiscovery_instanceKeySeparatesWorktrees(t *testing.T) {
	// Two worktrees of ONE repo: the display slug collides (that is the bug),
	// the instance key must not.
	parent, roots := discoverySiblings(t, 2, "https://github.com/alice/foo.git")
	if got, want := repoSlug(roots[0]), repoSlug(roots[1]); got != want {
		t.Fatalf("fixture must share one repo slug, got %q and %q", got, want)
	}
	keyA, keyB := instanceKey(roots[0]), instanceKey(roots[1])
	if keyA == keyB {
		t.Errorf("two worktrees of one repo must get distinct instance keys, both %q", keyA)
	}
	for _, root := range roots {
		if !strings.HasPrefix(root, parent) {
			t.Fatalf("fixture root %q outside parent %q", root, parent)
		}
	}
}

func TestDiscovery_instanceKeyFourSiblingsDistinct(t *testing.T) {
	// The reported setup: four instances, one repo, four terminal windows.
	_, roots := discoverySiblings(t, 4, "https://github.com/alice/foo.git")
	seen := map[string]string{}
	for _, root := range roots {
		key := instanceKey(root)
		if other, dup := seen[key]; dup {
			t.Errorf("instance key %q shared by %s and %s", key, other, root)
		}
		seen[key] = root
		if key == repoSlug(root) {
			t.Errorf("instance key %q must not equal the display slug alone (worktrees would collide)", key)
		}
	}
	if len(seen) != 4 {
		t.Errorf("instance keys = %d distinct, want 4", len(seen))
	}
}

func TestDiscovery_instanceKeyDeterministic(t *testing.T) {
	_, roots := discoverySiblings(t, 1, "https://github.com/alice/foo.git")
	first, second := instanceKey(roots[0]), instanceKey(roots[0])
	if first != second {
		t.Errorf("instanceKey must be deterministic: %q then %q", first, second)
	}
}

func TestDiscovery_instanceKeyPathVariants(t *testing.T) {
	// The same workspace spelled differently must resolve to one identity:
	// docker names are compared as strings, so a lexical variant that hashes
	// differently would look like a second instance.
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/foo.git")

	want := instanceKey(root)
	variants := []string{
		root,
		root + "/",
		parent + "/./ws",
		parent + "/x/../ws",
		root + "/.",
	}
	for _, variant := range variants {
		if got := instanceKey(variant); got != want {
			t.Errorf("instanceKey(%q) = %q, want %q (Abs+Clean before hashing)", variant, got, want)
		}
	}
}

func TestDiscovery_instanceKeyFormat(t *testing.T) {
	_, roots := discoverySiblings(t, 1, "https://github.com/alice/foo.git")
	root := roots[0]
	key := instanceKey(root)
	if !instanceKeyPattern.MatchString(key) {
		t.Errorf("instanceKey %q must match %s", key, instanceKeyPattern)
	}
	if !strings.HasPrefix(key, repoSlug(root)) {
		t.Errorf("instanceKey %q must keep the display slug %q as its prefix", key, repoSlug(root))
	}
	if strings.HasSuffix(key, "-") {
		t.Errorf("instanceKey %q must not end with a separator", key)
	}
}

func TestDiscovery_instanceKeyNoDigestCollisions(t *testing.T) {
	// One hundred sibling workspaces differing only by index: the path digest
	// must never truncate two of them onto one key.
	parent := t.TempDir()
	if err := os.MkdirAll(filepath.Join(parent, ".bare"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeBareRemote(t, parent, "https://github.com/alice/foo.git")
	seen := map[string]string{}
	for i := 0; i < 100; i++ {
		root := filepath.Join(parent, fmt.Sprintf("ws%03d", i))
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatal(err)
		}
		key := instanceKey(root)
		if other, dup := seen[key]; dup {
			t.Fatalf("instance key %q collides for %s and %s", key, other, root)
		}
		seen[key] = root
	}
	if len(seen) != 100 {
		t.Errorf("distance keys = %d, want 100", len(seen))
	}
}

func TestDiscovery_instanceKeyFallbackNoRemote(t *testing.T) {
	// No resolvable .bare remote: the key still derives from the folder
	// basename plus the path digest, is never empty, and stays docker-safe.
	_, roots := discoverySiblings(t, 2, "")
	for _, root := range roots {
		key := instanceKey(root)
		if key == "" {
			t.Fatalf("instanceKey(%q) must never be empty", root)
		}
		if !instanceKeyPattern.MatchString(key) {
			t.Errorf("instanceKey(%q) = %q must match %s", root, key, instanceKeyPattern)
		}
		if !strings.HasPrefix(key, repoSlug(root)) {
			t.Errorf("instanceKey(%q) = %q must keep the basename slug %q as its prefix", root, key, repoSlug(root))
		}
	}
	if instanceKey(roots[0]) == instanceKey(roots[1]) {
		t.Error("sibling folders without a remote must still get distinct keys")
	}
}

func TestDiscovery_instanceKeyLongSlugKeepsDistinctContainers(t *testing.T) {
	// Two repos whose slugs share their first 60 characters: plain truncation
	// would collapse them onto one container name once the path digest is
	// appended, so the over-long path must stay collision-free AND fit the
	// RFC 1034 label limit.
	longA := strings.Repeat("a", 60)
	longB := longA + "b"
	parentA, rootA := mkWorkspace(t, `{}`)
	writeBareRemote(t, parentA, "https://github.com/alice/"+longA+".git")
	parentB, rootB := mkWorkspace(t, `{}`)
	writeBareRemote(t, parentB, "https://github.com/alice/"+longB+".git")

	if instanceKey(rootA) == instanceKey(rootB) {
		t.Fatalf("over-long slugs must stay distinct, both %q", instanceKey(rootA))
	}
	if containerName(rootA) == containerName(rootB) {
		t.Errorf("container names must stay distinct, both %q", containerName(rootA))
	}
	if codeflowContainerName(rootA) == codeflowContainerName(rootB) {
		t.Errorf("codeflow container names must stay distinct, both %q", codeflowContainerName(rootA))
	}
	if uiContainerName(rootA) == uiContainerName(rootB) {
		t.Errorf("ui container names must stay distinct, both %q", uiContainerName(rootA))
	}
	for _, root := range []string{rootA, rootB} {
		for _, name := range []string{containerName(root), codeflowContainerName(root), uiContainerName(root)} {
			if len(name) > 63 {
				t.Errorf("container name %q is %d chars, want <= 63 (embedded DNS label limit)", name, len(name))
			}
		}
	}
}

func TestDiscovery_repoSlugStaysDisplayOnly(t *testing.T) {
	// repoSlug keeps its historical meaning (owner-repo) so documentation,
	// labels and the key prefix stay stable — the path digest is appended, not
	// substituted.
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/foo.git")
	if got := repoSlug(root); got != "alice-foo" {
		t.Errorf("repoSlug = %q, want alice-foo (display identity unchanged)", got)
	}
	key := instanceKey(root)
	if !strings.HasPrefix(key, "alice-foo-") {
		t.Errorf("instanceKey = %q, want the alice-foo prefix plus a path digest", key)
	}
	if len(key) != len("alice-foo")+1+8 {
		t.Errorf("instanceKey = %q, want <slug>-<8 hex path digest>", key)
	}
}
