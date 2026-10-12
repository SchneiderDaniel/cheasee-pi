package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func composeEnvForTest(t *testing.T, root string) []string {
	t.Helper()
	env := []string{
		"WORKSPACE_HOST_PATH=" + root,
		"WORKSPACE_BARE_PATH=" + filepath.Join(filepath.Dir(root), ".bare"),
		"CHEASEEPI_CONTAINER=" + containerName(root),
		"CODEFLOW_CONTAINER=" + codeflowContainerName(root),
		"PI_UI_CONTAINER=" + uiContainerName(root),
		"COMPOSE_PROJECT_NAME=" + composeProjectName(root),
		"PI_UI_PORT=9500",
		"CODEFLOW_PORT=8470",
	}
	for _, kv := range env {
		key, value, _ := strings.Cut(kv, "=")
		t.Setenv(key, value)
	}
	return env
}

// ──────────────────────────────────────────────
// Extracted seam-factory tests
// ──────────────────────────────────────────────

func TestGitRootMock(t *testing.T) {
	root := t.TempDir()
	type call struct {
		name string
		arg  []string
	}
	var passCalls []call
	sentinel := &mockCmd{outputFn: func() ([]byte, error) { return []byte("sentinel"), nil }}
	seam := gitRootMock(root, func(_ context.Context, name string, arg ...string) runner {
		passCalls = append(passCalls, call{name, append([]string(nil), arg...)})
		return sentinel
	})
	ctx := context.Background()
	out := func(name string, arg ...string) string {
		b, _ := seam(ctx, name, arg...).Output()
		return string(b)
	}

	if got := out("git", "rev-parse", "--is-inside-work-tree"); got != "true" {
		t.Errorf("--is-inside-work-tree = %q, want true", got)
	}
	if got := out("git", "-C", root, "rev-parse", "--show-prefix"); got != "" {
		t.Errorf("--show-prefix at toplevel = %q, want %q", got, "")
	}
	if got := out("git", "-C", filepath.Join(root, "sub"), "rev-parse", "--show-prefix"); got != "sub/" {
		t.Errorf("--show-prefix sub = %q, want sub/", got)
	}
	if got := out("git", "-C", filepath.Join(root, "sub", "deep"), "rev-parse", "--show-prefix"); got != "sub/deep/" {
		t.Errorf("--show-prefix deep = %q, want sub/deep/", got)
	}
	// No -C: filepath.Rel errors on the empty target, so git reports "" too.
	if got := out("git", "rev-parse", "--show-prefix"); got != "" {
		t.Errorf("--show-prefix without -C = %q, want %q", got, "")
	}
	if got := out("git", "-C", filepath.Join(root, "first"), "-C", filepath.Join(root, "sub"), "rev-parse", "--show-prefix"); got != "sub/" {
		t.Errorf("duplicate -C must take the last, got %q, want sub/", got)
	}
	if got := out("git", "rev-parse", "--show-toplevel"); got != root {
		t.Errorf("unknown git arg = %q, want root %q", got, root)
	}
	// Documents the filepath.Rel dependency: outside root yields "../<sibling>/".
	if got := out("git", "-C", filepath.Join(filepath.Dir(root), "sibling"), "rev-parse", "--show-prefix"); got != "../sibling/" {
		t.Errorf("--show-prefix outside root = %q, want ../sibling/", got)
	}

	if got := seam(ctx, "git", "config", "--get", "remote.origin.url"); got != sentinel {
		t.Errorf("git config must return the passthrough runner")
	}
	if len(passCalls) != 1 || passCalls[0].name != "git" || !slices.Equal(passCalls[0].arg, []string{"config", "--get", "remote.origin.url"}) {
		t.Errorf("git config passthrough = %+v, want one identical call", passCalls)
	}

	if got := seam(ctx, "docker", "version"); got != sentinel {
		t.Errorf("non-git must return the passthrough runner")
	}
	if len(passCalls) != 2 || passCalls[1].name != "docker" || !slices.Equal(passCalls[1].arg, []string{"version"}) {
		t.Errorf("non-git passthrough = %+v, want one identical call", passCalls)
	}
}

func TestNewWorkspace(t *testing.T) {
	parent, workdir := newWorkspace(t)
	if workdir != filepath.Join(parent, "ws") {
		t.Errorf("workdir = %q, want %q", workdir, filepath.Join(parent, "ws"))
	}
	for _, dir := range []string{parent, workdir} {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			t.Errorf("%q must exist as a dir: %v", dir, err)
		}
	}
	// Empty: no settings file, no sibling .bare — deliberately NOT mkWorkspace.
	for _, p := range []string{filepath.Join(workdir, "cheasee-settings.json"), filepath.Join(parent, ".bare")} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%q must not exist, got err=%v", p, err)
		}
	}
	if parent2, _ := newWorkspace(t); parent2 == parent {
		t.Error("two calls must return disjoint roots")
	}
}
