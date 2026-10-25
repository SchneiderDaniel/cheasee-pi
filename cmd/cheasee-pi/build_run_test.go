package main

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

func TestRunRebuildE_StampNonEmpty(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{}
	stub.install(t)
	if err := runRebuildE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runRebuildE: %v", err)
	}
	if len(stub.compose) != 1 {
		t.Fatalf("expected exactly one compose build, got %d", len(stub.compose))
	}
	argv := stub.composeArgv()
	if slices.Contains(argv, "--build-arg") {
		t.Errorf("stamp must ride the compose env, not the argv, got %v", argv)
	}
	var stamp string
	for _, e := range stub.compose[0].env {
		if strings.HasPrefix(e, "PI_BUILD_STAMP=") {
			stamp = strings.TrimPrefix(e, "PI_BUILD_STAMP=")
		}
	}
	if stamp == "" {
		t.Errorf("PI_BUILD_STAMP must be non-empty in the compose env (cache-busting contract), got %v", stub.compose[0].env)
	}
}

func TestRunBuildE_CachedBuildNoFlagsNoPrune(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{}
	stub.install(t)
	stderr := testutil.CaptureStderr(t, func() {
		if err := runBuildE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runBuildE: %v", err)
		}
	})
	argv := stub.composeArgv()
	for _, flag := range []string{"--no-cache", "--pull"} {
		if slices.Contains(argv, flag) {
			t.Errorf("cached build must not pass %s, got %v", flag, argv)
		}
	}
	for _, entry := range stub.log {
		if strings.HasPrefix(entry, "exec:") {
			t.Errorf("cached build must issue zero prune commands, got %v", stub.log)
		}
	}
	// The cached path prints the plain label, never the full-rebuild marker
	// (#2050 regression on the #2003 complexity ceiling: one branch token).
	for _, tt := range []struct {
		sub  string
		want bool
	}{
		{"Building container image...\n", true},
		{"full rebuild", false},
	} {
		if strings.Contains(stderr, tt.sub) != tt.want {
			t.Errorf("cached build stderr %q presence = %v, want %v (got %q)", tt.sub, !tt.want, tt.want, stderr)
		}
	}
}

func TestRunBuildE_ComposeFileFromCacheDir(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	xdg := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", xdg)
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{}
	stub.install(t)
	if err := runBuildE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runBuildE: %v", err)
	}
	argv := stub.composeArgv()
	wantFile := filepath.Join(xdg, "cheasee-pi", cliVersion(), "docker-compose.yml")
	if argv[2] != "-f" || argv[3] != wantFile {
		t.Errorf("-f must point at %s, got %v", wantFile, argv)
	}
}

func TestComposeBuild_StampExtrasAndNoticeOrder(t *testing.T) {
	// Direct contract test for the extracted helper: stamp always present and
	// non-empty, caller extras appended in order, and the optional notice
	// printed before the label with blank-line separation.
	savedProbe := portProbe
	portProbe = func(int) error { return nil } // no real socket binds
	t.Cleanup(func() { portProbe = savedProbe })

	composeDir := t.TempDir()
	workspace := t.TempDir()

	// Only compose invocations are recorded: the disk gate also runs a
	// `docker info --format` in front (its free space is undeterminable here →
	// fail open).
	var recorded [][]string
	var built *mockCmd
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "compose") {
			recorded = append(recorded, append([]string(nil), arg...))
			built = &mockCmd{}
			return built
		}
		return &mockCmd{}
	})

	stderr := testutil.CaptureStderr(t, func() {
		if err := composeBuild(context.Background(), composeDir, workspace, "cheasee-pi-x", composeBuildSpec{
			extraArgs: []string{"--no-cache", "--pull"},
			label:     "Building container image (no cache), full rebuild",
			notice:    "First start downloads ~1GB",
		}); err != nil {
			t.Fatalf("composeBuild: %v", err)
		}
	})

	if len(recorded) != 1 {
		t.Fatalf("expected one docker invocation, got %v", recorded)
	}
	argv := recorded[0]
	wantPrefix := []string{"compose", "-f", filepath.Join(composeDir, "docker-compose.yml"), "build"}
	if len(argv) != 6 || !slices.Equal(argv[:4], wantPrefix) {
		t.Fatalf("unexpected argv = %v", argv)
	}
	if argv[4] != "--no-cache" || argv[5] != "--pull" {
		t.Fatalf("caller extras must be appended in order, got %v", argv)
	}
	var stamp string
	for _, e := range built.env {
		if strings.HasPrefix(e, "PI_BUILD_STAMP=") {
			stamp = strings.TrimPrefix(e, "PI_BUILD_STAMP=")
		}
	}
	if stamp == "" {
		t.Fatalf("stamp must ride the compose env, got %v", built.env)
	}
	noticeIdx := strings.Index(stderr, "First start downloads ~1GB")
	labelIdx := strings.Index(stderr, "Building container image (no cache), full rebuild")
	if noticeIdx < 0 || labelIdx < 0 || labelIdx < noticeIdx {
		t.Fatalf("notice must precede the label, got %q", stderr)
	}
	if !strings.Contains(stderr[noticeIdx:labelIdx], "\n\n") {
		t.Errorf("notice must be blank-line separated from the label, got %q", stderr)
	}
}

// ──────────────────────────────────────────────
// Phase 3: rebuild prune ordering + scope
// ──────────────────────────────────────────────
