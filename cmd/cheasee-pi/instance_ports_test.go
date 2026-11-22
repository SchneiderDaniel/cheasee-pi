package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// Phase 2 (cont.): derived host ports stay distinct per worktree
//
// Two worktrees of one repo must land in different port bands. The derived port
// is `base + hash(instanceKey) % span` with a next-free probe fallback, so a
// collision is possible in principle — the resolver shifts onto a free port.
// ──────────────────────────────────────────────

// discoveryPortSiblings returns four sibling worktree roots (one remote) whose
// DERIVED UI ports are pairwise distinct. It walks candidate parents until the
// four keys land on four ports (bounded — a 1024-port band makes a collision
// unlikely per candidate).
func discoveryPortSiblings(t *testing.T) (string, []string) {
	t.Helper()
	base := t.TempDir()
	for attempt := 0; attempt < 200; attempt++ {
		parent, roots, collision := portSiblingCandidate(t, base, attempt)
		if !collision {
			return parent, roots
		}
	}
	t.Fatal("no collision-free four-worktree fixture found")
	return "", nil
}

// portSiblingCandidate builds one candidate parent with four worktrees and
// reports whether two of them derived the same UI port.
func portSiblingCandidate(t *testing.T, base string, attempt int) (parent string, roots []string, collision bool) {
	t.Helper()
	parent = filepath.Join(base, fmt.Sprintf("p%03d", attempt))
	if err := os.MkdirAll(filepath.Join(parent, ".bare"), 0o755); err != nil {
		t.Fatal(err)
	}
	// The remote exists BEFORE the ports are derived: repoSlug feeds the key,
	// and a slug that changes after derivation would invalidate the check.
	writeBareRemote(t, parent, "https://github.com/alice/foo.git")
	seen := map[string]bool{}
	for i := 1; i <= 4; i++ {
		root, port := portSiblingRoot(t, parent, i)
		collision = collision || seen[port]
		seen[port] = true
		roots = append(roots, root)
	}
	return parent, roots, collision
}

// portSiblingRoot creates the i-th worktree of parent and returns its derived
// UI port.
func portSiblingRoot(t *testing.T, parent string, i int) (root, port string) {
	t.Helper()
	root = filepath.Join(parent, fmt.Sprintf("ws%d", i))
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	testutil.WriteCheaseeSettingsFile(t, root, `{}`)
	port, err := uiHostPort(root)
	discoveryRequireNoErr(t, "uiHostPort", err)
	return root, port
}

func TestDiscovery_hostPortsDistinctPerWorktree(t *testing.T) {
	t.Setenv("PI_UI_PORT", "")
	t.Setenv("CODEFLOW_PORT", "")
	probes := stubPortProbe(t, true)
	if *probes != 0 {
		t.Fatalf("fixture resolution must not probe yet, probed %d times", *probes)
	}

	_, roots := discoveryPortSiblings(t)
	uiSeen, codeflowSeen := map[string]string{}, map[string]string{}
	for _, root := range roots {
		discoveryRequirePortsDistinct(t, root, uiSeen, codeflowSeen)
	}
	discoveryRequireStablePorts(t, roots)
}

// discoveryRequirePortsDistinct asserts one worktree's derived ports are inside
// their bands and unseen by its siblings.
func discoveryRequirePortsDistinct(t *testing.T, root string, uiSeen, codeflowSeen map[string]string) {
	t.Helper()
	uiPortValue, err := uiHostPort(root)
	discoveryRequireNoErr(t, "uiHostPort", err)
	codeflowPortValue, err := codeflowHostPort(root)
	discoveryRequireNoErr(t, "codeflowHostPort", err)
	discoveryRequirePort(t, "UI", uiPortValue, uiPortBase, uiPortBase+uiPortRange-1)
	discoveryRequirePort(t, "CodeFlow", codeflowPortValue, codeflowPortBase, codeflowPortBase+codeflowPortRange-1)
	for what, entry := range map[string]struct {
		value string
		seen  map[string]string
	}{"UI": {uiPortValue, uiSeen}, "CodeFlow": {codeflowPortValue, codeflowSeen}} {
		if other, dup := entry.seen[entry.value]; dup {
			t.Errorf("%s port %s shared by %s and %s", what, entry.value, other, root)
		}
		entry.seen[entry.value] = root
	}
}

// discoveryRequireStablePorts asserts a second resolution of one workspace
// returns the same port: the compose env, the hint and the in-container exec env
// must agree.
func discoveryRequireStablePorts(t *testing.T, roots []string) {
	t.Helper()
	for _, root := range roots {
		first, firstErr := uiHostPort(root)
		discoveryRequireNoErr(t, "uiHostPort", firstErr)
		second, secondErr := uiHostPort(root)
		discoveryRequireNoErr(t, "uiHostPort", secondErr)
		if first != second {
			t.Errorf("uiHostPort(%q) not stable: %q then %q", root, first, second)
		}
	}
}
