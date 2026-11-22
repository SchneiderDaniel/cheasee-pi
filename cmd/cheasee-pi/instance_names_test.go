package main

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
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
		*probes++
		if alwaysFree {
			return nil
		}
		return fmt.Errorf("address already in use: 127.0.0.1:%d", port)
	}
	t.Cleanup(func() { portProbe = saved })
	return probes
}

// discoveryPortSiblings returns four sibling worktree roots (one remote) whose
// DERIVED UI ports are pairwise distinct. Derived ports are `base +
// hash(key) % 1024` with a next-free probe fallback, so two keys can collide in
// principle; the real resolver shifts on the occupied port. This test asserts
// the collision-free fixture, so it walks candidate parents until the four keys
// land on four ports (bounded — a 1024-port band makes a collision unlikely per
// candidate).
func discoveryPortSiblings(t *testing.T) (string, []string) {
	t.Helper()
	base := t.TempDir()
	for attempt := 0; attempt < 200; attempt++ {
		parent := filepath.Join(base, fmt.Sprintf("p%03d", attempt))
		if err := os.MkdirAll(filepath.Join(parent, ".bare"), 0o755); err != nil {
			t.Fatal(err)
		}
		// The remote exists BEFORE the ports are derived: repoSlug feeds the
		// key, and a slug that changes after derivation would invalidate the
		// collision check below.
		writeBareRemote(t, parent, "https://github.com/alice/foo.git")
		roots := make([]string, 0, 4)
		seen := map[string]bool{}
		collision := false
		for i := 1; i <= 4; i++ {
			root := filepath.Join(parent, fmt.Sprintf("ws%d", i))
			if err := os.MkdirAll(root, 0o755); err != nil {
				t.Fatal(err)
			}
			testutil.WriteCheaseeSettingsFile(t, root, `{}`)
			port, err := uiHostPort(root)
			if err != nil {
				t.Fatalf("uiHostPort(%q): %v", root, err)
			}
			if seen[port] {
				collision = true
			}
			seen[port] = true
			roots = append(roots, root)
		}
		if !collision {
			return parent, roots
		}
	}
	t.Fatal("no collision-free four-worktree fixture found")
	return "", nil
}

func TestDiscovery_stackServicesDeriveFromInstanceKey(t *testing.T) {
	_, roots := discoverySiblings(t, 1, "https://github.com/alice/foo.git")
	root := roots[0]
	key := instanceKey(root)
	slug := repoSlug(root)

	services := stackServices(root)
	wantOrder := []string{"cheasee-pi", "codeflow", "ui"}
	if got := serviceKeys(services); !slices.Equal(got, wantOrder) {
		t.Fatalf("stack order = %v, want %v", got, wantOrder)
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
		uiPortValue, err := uiHostPort(root)
		if err != nil {
			t.Fatalf("uiHostPort(%q): %v", root, err)
		}
		codeflowPortValue, err := codeflowHostPort(root)
		if err != nil {
			t.Fatalf("codeflowHostPort(%q): %v", root, err)
		}
		for _, c := range []struct {
			what, value string
			low, high   int
			seen        map[string]string
		}{
			{"UI", uiPortValue, uiPortBase, uiPortBase + uiPortRange - 1, uiSeen},
			{"CodeFlow", codeflowPortValue, codeflowPortBase, codeflowPortBase + codeflowPortRange - 1, codeflowSeen},
		} {
			port, convErr := strconv.Atoi(c.value)
			if convErr != nil {
				t.Fatalf("%s port %q is not numeric: %v", c.what, c.value, convErr)
			}
			if port < c.low || port > c.high {
				t.Errorf("%s port %d for %s outside [%d, %d]", c.what, port, root, c.low, c.high)
			}
			if other, dup := c.seen[c.value]; dup {
				t.Errorf("%s port %s shared by %s and %s", c.what, c.value, other, root)
			}
			c.seen[c.value] = root
		}
	}

	// Stable: a second resolution of the same workspace returns the same port
	// (the compose env, the hint and the in-container exec env must agree).
	for _, root := range roots {
		first, err := uiHostPort(root)
		if err != nil {
			t.Fatal(err)
		}
		second, err := uiHostPort(root)
		if err != nil {
			t.Fatal(err)
		}
		if first != second {
			t.Errorf("uiHostPort(%q) not stable: %q then %q", root, first, second)
		}
	}
}

func TestDiscovery_hostPortExplicitWins(t *testing.T) {
	t.Run("env var", func(t *testing.T) {
		probes := stubPortProbe(t, true)
		_, root := mkWorkspace(t, `{}`)
		t.Setenv("PI_UI_PORT", "9700")
		got, err := uiHostPort(root)
		if err != nil {
			t.Fatalf("uiHostPort: %v", err)
		}
		if got != "9700" {
			t.Errorf("PI_UI_PORT=9700 must win, got %q", got)
		}
		if *probes != 0 {
			t.Errorf("an explicit port must never probe, probed %d times", *probes)
		}
	})

	t.Run("settings beat env", func(t *testing.T) {
		probes := stubPortProbe(t, true)
		_, root := mkWorkspace(t, `{"docker":{"uiPort":"9800"}}`)
		t.Setenv("PI_UI_PORT", "9700")
		got, err := uiHostPort(root)
		if err != nil {
			t.Fatalf("uiHostPort: %v", err)
		}
		if got != "9800" {
			t.Errorf("docker.uiPort=9800 must beat PI_UI_PORT, got %q", got)
		}
		if *probes != 0 {
			t.Errorf("an explicit port must never probe, probed %d times", *probes)
		}
	})
}

func TestDiscovery_hostPortRangeExhaustionFailsClosed(t *testing.T) {
	stubPortProbe(t, false)
	_, root := mkWorkspace(t, `{}`)
	t.Setenv("PI_UI_PORT", "")
	t.Setenv("CODEFLOW_PORT", "")

	_, err := uiHostPort(root)
	if err == nil {
		t.Fatal("an exhausted UI port band must fail closed, got nil error")
	}
	if !strings.Contains(err.Error(), "PI_UI_PORT") {
		t.Errorf("UI exhaustion error must name PI_UI_PORT, got %q", err.Error())
	}
	if !strings.Contains(err.Error(), strconv.Itoa(uiPortBase)) {
		t.Errorf("UI exhaustion error must name the band, got %q", err.Error())
	}
	_, err = codeflowHostPort(root)
	if err == nil {
		t.Fatal("an exhausted CodeFlow port band must fail closed, got nil error")
	}
	if !strings.Contains(err.Error(), "CODEFLOW_PORT") {
		t.Errorf("CodeFlow exhaustion error must name CODEFLOW_PORT, got %q", err.Error())
	}
}
