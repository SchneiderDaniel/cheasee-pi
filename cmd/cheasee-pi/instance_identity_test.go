package main

import (
	"fmt"
	"os"
	"path/filepath"
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
	_, roots := discoverySiblings(t, 2, "https://github.com/alice/foo.git")
	if got, want := repoSlug(roots[0]), repoSlug(roots[1]); got != want {
		t.Fatalf("fixture must share one repo slug, got %q and %q", got, want)
	}
	if instanceKey(roots[0]) == instanceKey(roots[1]) {
		t.Errorf("two worktrees of one repo must get distinct instance keys, both %q", instanceKey(roots[0]))
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
	for _, variant := range []string{root, root + "/", parent + "/./ws", parent + "/x/../ws", root + "/."} {
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
