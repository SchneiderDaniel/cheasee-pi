package main

import (
	"context"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestRunUpE_settingsButNoBareFailsClosed(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	testutil.WriteCheaseeSettingsFile(t, root, `{"docker": {"memory": "2G"}}`)
	// NO parent/.bare — corrupt workspace; compose must never be invoked
	// (Docker's create_host_path would otherwise create a stray host dir).
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)

	var composeCalls int
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "compose") {
			composeCalls++
			return &mockCmd{}
		}
		if name == "docker" && len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("24.0.9"), nil }}
		}
		if name == "docker" && slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		return &mockCmd{}
	})

	err := runUpE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "corrupt") {
		t.Fatalf("expected fail-closed error mentioning the corrupt workspace, got %v", err)
	}
	if !strings.Contains(err.Error(), "cheasee-pi init") {
		t.Errorf("error must carry the recovery hint, got %v", err)
	}
	if composeCalls != 0 {
		t.Errorf("compose must never be invoked when .bare is missing, got %d", composeCalls)
	}
}

func TestRunUpE_existingCheaseeSettingsUntouched(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	legacy := `{"defaultProvider": "openai", "docker": {"memory": ""}}`
	testutil.WriteCheaseeSettingsFile(t, root, legacy)
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)

	c := stubUpFlow(t, root, false)
	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}

	// Never-overwrite rule: byte-identical after start.
	after, err := os.ReadFile(filepath.Join(root, "cheasee-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != legacy {
		t.Errorf("existing cheasee-settings.json must be byte-preserved:\n got %q\nwant %q", after, legacy)
	}
	// Empty docker.memory → no CHEASEEPI_MEMORY env.
	upEnv := c.composeCmds[1].env
	for _, e := range upEnv {
		if strings.HasPrefix(e, "CHEASEEPI_MEMORY=") {
			t.Errorf("no memory limit configured → no CHEASEEPI_MEMORY, got %v", upEnv)
		}
	}
}

func TestRunUpE_subdirExecTarget(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	sub := filepath.Join(root, "sub", "dir")
	if err := os.MkdirAll(sub, 0755); err != nil {
		t.Fatal(err)
	}
	setUpRun(t, sub)

	c := stubUpFlow(t, root, false)
	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	// Dry-run prints the mounted exec target with the relative cwd.
	if !strings.Contains(stderr, "-w /workspaces/main/sub/dir") {
		t.Errorf("dry-run must exec at -w /workspaces/main/sub/dir, got: %q", stderr)
	}
	// Dry-run touches nothing: no compose, no .pi scaffold.
	if _, err := os.Stat(filepath.Join(root, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Errorf("dry-run must not scaffold settings, got: %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("dry-run must not invoke compose, got %d: %v", len(c.composeArgs), c.composeArgs)
	}
}

func TestRunUpE_subdirFullFlowMountsToplevel(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	sub := filepath.Join(root, "sub", "dir")
	if err := os.MkdirAll(sub, 0755); err != nil {
		t.Fatal(err)
	}
	setUpRunMode(t, sub, false)
	exec := stubExecPIContainer(t)

	c := stubUpFlow(t, root, false)
	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}

	// Toplevel is mounted; exec descends to the relative cwd.
	if exec.target != "/workspaces/main/sub/dir" {
		t.Errorf("exec must target -w /workspaces/main/sub/dir, got %q", exec.target)
	}
	// start never scaffolds .pi/settings.json anymore.
	if _, err := os.Stat(filepath.Join(root, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Errorf("start must not scaffold .pi/settings.json at the workspace root: %v", err)
	}
	// Compose still invoked with the cache-dir compose file and the toplevel mount.
	cacheDir, err := CacheDir()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(c.composeArgs[0], " "), cacheDir) {
		t.Errorf("compose must run from the cache dir, got %v", c.composeArgs[0])
	}
	upEnv := c.composeCmds[1].env
	if !slices.Contains(upEnv, "WORKSPACE_HOST_PATH="+root) {
		t.Errorf("up env must carry WORKSPACE_HOST_PATH=%s (toplevel, not cwd), got %v", root, upEnv)
	}
}

func TestRunUpE_containerRunningSkipsComposeUp(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)

	c := stubUpFlow(t, root, true)
	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("running container must skip compose up, got %d invocations: %v", len(c.composeArgs), c.composeArgs)
	}
	// Orphan scan + exec still run against the running container.
	if exec.name != containerName(root) {
		t.Errorf("exec must still run against the running container, got name=%q", exec.name)
	}
}

func TestRunUpE_selinuxRelabelToggle(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)

	// Unset (default): no VOLUME_RELABEL — bind mounts unchanged.
	t.Setenv("CHEASEEPI_SELINUX_RELABEL", "")
	c := stubUpFlow(t, root, false)
	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}
	upEnv := c.composeCmds[1].env
	for _, e := range upEnv {
		if strings.HasPrefix(e, "VOLUME_RELABEL=") {
			t.Errorf("unset toggle must not set VOLUME_RELABEL, got %v", upEnv)
		}
	}

	// CHEASEEPI_SELINUX_RELABEL=1 → :Z appended to every bind mount.
	t.Setenv("CHEASEEPI_SELINUX_RELABEL", "1")
	c2 := stubUpFlow(t, root, false)
	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}
	upEnv2 := c2.composeCmds[1].env
	if !slices.Contains(upEnv2, "VOLUME_RELABEL=:Z") {
		t.Errorf("toggle=1 must set VOLUME_RELABEL=:Z, got %v", upEnv2)
	}
}

// ──────────────────────────────────────────────
// First-build notice + launch cheatsheet (runUpE use cases)
// ──────────────────────────────────────────────

// assertOrderedStderr asserts stderr contains every want substring with
// strictly increasing indexes (each later line renders after the previous).
func assertOrderedStderr(t *testing.T, stderr string, wants ...string) {
	t.Helper()
	last := -1
	for _, want := range wants {
		i := strings.Index(stderr, want)
		if i < 0 {
			t.Errorf("stderr must contain %q, got: %q", want, stderr)
			continue
		}
		if i < last {
			t.Errorf("stderr order violated: %q renders before a previous required line, got: %q", want, stderr)
		}
		last = i
	}
}

func TestRunUpE_firstStartUserJourney(t *testing.T) {
	// Persona: new user, first `cheasee-pi start` on an initialized
	// workspace. Image missing (stub default) → every user-visible feedback
	// step in order: first-build notice → build label → starting → started →
	// CodeFlow URL → cheatsheet; exactly one exec at /workspaces/main.
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)

	c := stubUpFlow(t, root, false)
	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	assertOrderedStderr(t, stderr,
		"First start downloads",
		"Building container image...",
		"Starting container...",
		"✓ Container started",
		"CodeFlow",
		"inside pi:",
	)
	if exec.name != containerName(root) || exec.target != "/workspaces/main" {
		t.Errorf("expected exactly one exec at -w /workspaces/main, got name=%q target=%q", exec.name, exec.target)
	}
	if n := strings.Count(stderr, "First start downloads"); n != 1 {
		t.Errorf("notice must appear exactly once, got %d in: %q", n, stderr)
	}
	if n := strings.Count(stderr, "inside pi:"); n != 1 {
		t.Errorf("cheatsheet must appear exactly once, got %d in: %q", n, stderr)
	}
	if len(c.composeArgs) != 2 {
		t.Errorf("first start must build + up, got %d compose calls", len(c.composeArgs))
	}
}

func TestRunUpE_cheatsheetCarriesAllHints(t *testing.T) {
	// The one cheatsheet line carries all four session-management hints.
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)
	stubUpFlow(t, root, false)

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})
	for _, hint := range []string{"/help", "Ctrl+D", "cheasee-pi down", "cheasee-pi clean"} {
		if !strings.Contains(stderr, hint) {
			t.Errorf("cheatsheet must carry hint %q, got: %q", hint, stderr)
		}
	}
	if n := strings.Count(stderr, "inside pi:"); n != 1 {
		t.Errorf("exactly one cheatsheet line expected, got %d in: %q", n, stderr)
	}
}

func TestRunUpE_returningUserCheatsheetNoNoticeNoCompose(t *testing.T) {
	// Persona: returning user, container already running — CodeFlow URL +
	// cheatsheet on every launch, no first-build notice, no compose, no
	// image gate.
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)

	c := stubUpFlow(t, root, true)
	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	assertOrderedStderr(t, stderr, "CodeFlow", "inside pi:")
	if strings.Contains(stderr, "First start downloads") {
		t.Errorf("returning user must not see the first-build notice, got: %q", stderr)
	}
	if n := strings.Count(stderr, "inside pi:"); n != 1 {
		t.Errorf("cheatsheet must print exactly once on a running-container start, got %d in: %q", n, stderr)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("running container must skip compose, got %d calls", len(c.composeArgs))
	}
	if c.imageGates != 0 {
		t.Errorf("no build will run → no image gate, got %d", c.imageGates)
	}
	if exec.name != containerName(root) {
		t.Errorf("exec must still run against the running container, got name=%q", exec.name)
	}
}
