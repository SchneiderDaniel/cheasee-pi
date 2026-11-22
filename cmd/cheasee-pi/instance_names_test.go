package main

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 2: derived container, project and port names from the instance key
//
// Every name a second worktree could collide on — container, compose project,
// image ref, host port — must derive from the per-workspace key, not from the
// repo slug alone.
// ──────────────────────────────────────────────

// stubPortProbe replaces the host-port probe seam for the test's lifetime.
// alwaysFree reports every port as bindable; the returned counter records how
// often the probe ran (0 proves a path never probed).
func stubPortProbe(t *testing.T, alwaysFree bool) *int {
	t.Helper()
	saved := portProbe
	probes := new(int)
	portProbe = func(port int) error {
		if alwaysFree {
			*probes++
			return nil
		}
		*probes++
		return fmt.Errorf("address already in use: 127.0.0.1:%d", port)
	}
	t.Cleanup(func() { portProbe = saved })
	return probes
}

func TestDiscovery_stackServicesDeriveFromInstanceKey(t *testing.T) {
	_, roots := discoverySiblings(t, 1, "https://github.com/alice/foo.git")
	root := roots[0]
	key := instanceKey(root)
	slug := repoSlug(root)

	services := stackServices(root)
	if got, want := serviceKeys(services), []string{"cheasee-pi", "codeflow", "ui"}; !slices.Equal(got, want) {
		t.Fatalf("stack order = %v, want %v", got, want)
	}
	for _, s := range services {
		if !strings.Contains(s.container, key) {
			t.Errorf("container %q must derive from instance key %q", s.container, key)
		}
		if !strings.Contains(s.image, key) {
			t.Errorf("image %q must derive from instance key %q", s.image, key)
		}
		// The pre-change slug-only derivation must be gone: reusing it is
		// exactly what let a second worktree attach to the first one's stack.
		for _, stale := range []string{"cheasee-pi-" + slug, "codeflow-" + slug, "ui-" + slug} {
			if s.container == stale {
				t.Errorf("container %q still uses the slug-only derivation", stale)
			}
		}
	}
}

func TestDiscovery_stackServicesSiblingsArePairwiseDistinct(t *testing.T) {
	_, roots := discoverySiblings(t, 4, "https://github.com/alice/foo.git")
	seen := map[string]string{}
	projects := map[string]string{}
	for _, root := range roots {
		for _, s := range stackServices(root) {
			if other, dup := seen[s.container]; dup {
				t.Errorf("container %q shared by %s and %s", s.container, other, root)
			}
			seen[s.container] = root
		}
		project := composeProjectName(root)
		if other, dup := projects[project]; dup {
			t.Errorf("compose project %q shared by %s and %s", project, other, root)
		}
		projects[project] = root
	}
	if len(seen) != 12 {
		t.Errorf("containers = %d, want 12 (four worktrees × three services)", len(seen))
	}
	if len(projects) != 4 {
		t.Errorf("compose projects = %d, want 4", len(projects))
	}
}

func TestDiscovery_composeProjectDiffersPerWorktree(t *testing.T) {
	_, roots := discoverySiblings(t, 2, "https://github.com/alice/foo.git")
	if composeProjectName(roots[0]) == composeProjectName(roots[1]) {
		t.Errorf("compose projects must differ per worktree, both %q", composeProjectName(roots[0]))
	}
	for _, root := range roots {
		project := composeProjectName(root)
		if got, want := cheaseeImageRef(root), project+"-cheasee-pi"; got != want {
			t.Errorf("cheaseeImageRef = %q, want %q", got, want)
		}
		if len(project) > 54 {
			t.Errorf("compose project %q is %d chars, want <= 54 (<project>_default fits a 63-char label)", project, len(project))
		}
	}
}
