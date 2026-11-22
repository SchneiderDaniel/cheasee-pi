package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 1 (cont.): sibling worktrees keep distinct identities
//
// The reported host ran four instances of one repo side by side. These are the
// collision properties that must hold for every sibling: distinct keys, no
// digest truncation, and a usable key even when no remote can be resolved.
// ──────────────────────────────────────────────

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
		t.Errorf("distinct keys = %d, want 100", len(seen))
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
	rootA, rootB := overLongSlugPair(t)
	if instanceKey(rootA) == instanceKey(rootB) {
		t.Fatalf("over-long slugs must stay distinct, both %q", instanceKey(rootA))
	}
	for what, names := range map[string][2]string{
		"container": {containerName(rootA), containerName(rootB)},
		"codeflow":  {codeflowContainerName(rootA), codeflowContainerName(rootB)},
		"ui":        {uiContainerName(rootA), uiContainerName(rootB)},
	} {
		if names[0] == names[1] {
			t.Errorf("%s container names must stay distinct, both %q", what, names[0])
		}
	}
	for _, name := range containerNamesFor(rootA, rootB) {
		if len(name) > 63 {
			t.Errorf("container name %q is %d chars, want <= 63 (embedded DNS label limit)", name, len(name))
		}
	}
}

// overLongSlugPair builds two workspaces whose repo slugs share their first 60
// characters — plain truncation would collapse them onto one container name
// once the path digest is appended.
func overLongSlugPair(t *testing.T) (rootA, rootB string) {
	t.Helper()
	long := strings.Repeat("a", 60)
	parentA, rootA := mkWorkspace(t, `{}`)
	writeBareRemote(t, parentA, "https://github.com/alice/"+long+".git")
	parentB, rootB := mkWorkspace(t, `{}`)
	writeBareRemote(t, parentB, "https://github.com/alice/"+long+"b.git")
	return rootA, rootB
}

// containerNamesFor lists the three derived container names of each workspace.
func containerNamesFor(roots ...string) []string {
	names := make([]string, 0, 3*len(roots))
	for _, root := range roots {
		names = append(names, containerName(root), codeflowContainerName(root), uiContainerName(root))
	}
	return names
}
