package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// ──────────────────────────────────────────────
// Harness: build/rebuild seams
// ──────────────────────────────────────────────

// resetBuildState pins the build/rebuild package vars for the duration of a
// test. The vars are shared across the build and rebuild commands (one
// command per process), so a test must reset them before and after.
func resetBuildState(t *testing.T) {
	t.Helper()
	buildWorkdir = ""
	buildNoDockerCheck = false
	buildNoCache = false
	t.Cleanup(func() {
		buildWorkdir = ""
		buildNoDockerCheck = false
		buildNoCache = false
	})
}

// buildWorkspaceFixture creates a real git worktree (bare clone + worktree
// add via the real git binary) with cheasee-settings.json, so repoRoot and
// bareRepoURL resolve against genuine git state. Returns the worktree root.
func buildWorkspaceFixture(t *testing.T) string {
	t.Helper()
	src := gitRemoteFixture(t, "main")
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	cloneWorktreeLayout(t, src, parent, root)
	testutil.WriteCheaseeSettingsFile(t, root, "{}")
	return root
}

// buildTestStub installs the docker seams for the build/rebuild core and
// records every docker invocation into one serial call log (order matters:
// pre- vs post-build prune is a pinned behavior). git commands fall through
// to the real binary — repoRoot and bareRepoURL need genuine git state from
// the workspace fixture.
type buildTestStub struct {
	log        []string   // serial log of every docker invocation ("run:"/ "exec:" prefixed)
	compose    []*mockCmd // captured compose build runners (env/dir assertions)
	buildErr   error      // when non-nil, the compose build Run returns it
	pruneErr   error      // when non-nil, prune-era commands fail (best-effort swallow)
	noDangling bool       // when true, `docker images --filter dangling=true -q` returns empty
}

func (s *buildTestStub) install(t *testing.T) {
	t.Helper()
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return saved(ctx, name, arg...) // git (repoRoot, gitCommand)
		}
		s.log = append(s.log, "run:"+strings.Join(append([]string{name}, arg...), " "))
		c := &mockCmd{runFn: func() error { return s.buildErr }}
		s.compose = append(s.compose, c)
		return c
	})
	stubExecCommand(t, func(name string, arg ...string) cmdIface {
		if name != "docker" {
			return exec.Command(name, arg...) // git (bareRepoURL)
		}
		s.log = append(s.log, "exec:"+strings.Join(append([]string{name}, arg...), " "))
		switch {
		case slices.Contains(arg, "images"): // docker images --filter dangling=true -q
			if s.noDangling {
				return &mockCmd{outputFn: func() ([]byte, error) { return nil, nil }}
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("sha256:abc\n"), nil }}
		case arg[0] == "image" || arg[0] == "buildx": // docker image prune -f / buildx prune -f
			return &mockCmd{combinedFn: func() ([]byte, error) { return nil, s.pruneErr }}
		}
		return &mockCmd{}
	})
}

// logPrefixes returns the index of the first log entry with the given prefix.
func logIndex(log []string, prefix string) int {
	return slices.IndexFunc(log, func(s string) bool { return strings.HasPrefix(s, prefix) })
}

// composeArgv returns the captured compose-build argv ("docker compose -f ...")
// from the serial log, or nil when no compose build ran. The prune commands
// may precede the build (`build --no-cache` compat), so never assume the
// compose entry is log[0].
func (s *buildTestStub) composeArgv() []string {
	for _, entry := range s.log {
		if strings.HasPrefix(entry, "run:docker compose") {
			return strings.Split(strings.TrimPrefix(entry, "run:"), " ")
		}
	}
	return nil
}

// ──────────────────────────────────────────────
// Phase 1: command registration + help surface
// ──────────────────────────────────────────────

func TestRebuildCmd_Registered(t *testing.T) {
	found := false
	for _, c := range rootCmd.Commands() {
		if c.Name() == "rebuild" {
			found = true
			if c.RunE == nil {
				t.Error("rebuildCmd.RunE must be non-nil (use RunE, not Run)")
			}
			if !c.DisableAutoGenTag {
				t.Error("rebuildCmd.DisableAutoGenTag should be true")
			}
		}
	}
	if !found {
		t.Error("rebuildCmd must be registered on rootCmd")
	}
}

func TestRebuildCmd_Flags(t *testing.T) {
	if rebuildCmd.Flags().Lookup("workdir") == nil {
		t.Error("rebuild must expose --workdir")
	}
	if rebuildCmd.Flags().Lookup("no-docker-check") == nil {
		t.Error("rebuild must expose --no-docker-check")
	}
	if rebuildCmd.Flags().Lookup("no-cache") != nil {
		t.Error("rebuild must NOT expose --no-cache (no-cache is inherent to the command)")
	}
}

func TestRebuildCmd_Help(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "rebuild", "--help")
	if err != nil {
		t.Fatalf("rebuild --help: %v", err)
	}
	for _, want := range []string{"--workdir", "--no-docker-check", "no-cache", "prune"} {
		if !strings.Contains(output, want) {
			t.Errorf("rebuild --help should mention %q\n--- output:\n%s", want, output)
		}
	}
	if strings.Contains(output, "--no-cache flag") {
		t.Errorf("rebuild --help must not list a --no-cache flag\n--- output:\n%s", output)
	}
}

// ──────────────────────────────────────────────
// Phase 2: build core arg construction
// ──────────────────────────────────────────────

func TestRunRebuildE_ArgsContainNoCacheAndPull(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	xdg := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", xdg)
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
	if len(argv) < 9 || argv[0] != "docker" || argv[1] != "compose" {
		t.Fatalf("unexpected compose argv: %v", argv)
	}
	wantFile := filepath.Join(xdg, "cheasee-pi", cliVersion(), "docker-compose.yml")
	if argv[2] != "-f" || argv[3] != wantFile {
		t.Fatalf("-f must point at the version-keyed cache compose file, got %v", argv)
	}
	if argv[4] != "build" {
		t.Fatalf("compose build missing, got %v", argv)
	}
	if argv[5] != "--build-arg" || !strings.HasPrefix(argv[6], "PI_BUILD_STAMP=") {
		t.Fatalf("PI_BUILD_STAMP build arg missing, got %v", argv)
	}
	if argv[7] != "--no-cache" || argv[8] != "--pull" {
		t.Fatalf("rebuild must pass --no-cache and --pull, got %v", argv)
	}
}

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
	argv := stub.composeArgv()
	stamp := strings.TrimPrefix(argv[6], "PI_BUILD_STAMP=")
	if stamp == "" {
		t.Errorf("PI_BUILD_STAMP must be non-empty (cache-busting contract), got %q", argv[6])
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
	if err := runBuildE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runBuildE: %v", err)
	}
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
}

func TestRunBuildE_NoCacheKeepsPreBuildPrune(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	buildNoCache = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{}
	stub.install(t)
	if err := runBuildE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runBuildE: %v", err)
	}
	argv := stub.composeArgv()
	if !slices.Contains(argv, "--no-cache") {
		t.Errorf("build --no-cache must pass --no-cache, got %v", argv)
	}
	if slices.Contains(argv, "--pull") {
		t.Errorf("build --no-cache must NOT pass --pull (compat path unchanged), got %v", argv)
	}
	composeIdx := logIndex(stub.log, "run:docker compose")
	imagesIdx := logIndex(stub.log, "exec:docker images")
	pruneIdx := logIndex(stub.log, "exec:docker image prune")
	buildxIdx := logIndex(stub.log, "exec:docker buildx")
	if composeIdx == -1 || imagesIdx == -1 || pruneIdx == -1 || buildxIdx == -1 {
		t.Fatalf("expected compose build + full prune sequence, log: %v", stub.log)
	}
	if !(imagesIdx < composeIdx) {
		t.Errorf("build --no-cache must prune BEFORE the build (compat ordering), log: %v", stub.log)
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

// ──────────────────────────────────────────────
// Phase 3: rebuild prune ordering + scope
// ──────────────────────────────────────────────

func TestRunRebuildE_PrunesAfterBuild(t *testing.T) {
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
	composeIdx := logIndex(stub.log, "run:docker compose")
	imagesIdx := logIndex(stub.log, "exec:docker images")
	pruneIdx := logIndex(stub.log, "exec:docker image prune")
	buildxIdx := logIndex(stub.log, "exec:docker buildx")
	if composeIdx == -1 || imagesIdx == -1 || pruneIdx == -1 || buildxIdx == -1 {
		t.Fatalf("expected compose build + post-build prune sequence, log: %v", stub.log)
	}
	if !(composeIdx < imagesIdx && imagesIdx < pruneIdx && pruneIdx < buildxIdx) {
		t.Errorf("rebuild must prune AFTER the build, in order, log: %v", stub.log)
	}
}

func TestRunRebuildE_PruneScope(t *testing.T) {
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
	for _, entry := range stub.log {
		for _, forbidden := range []string{" docker ps", " docker rm", "system prune", " docker stop"} {
			if strings.Contains(entry, forbidden) {
				t.Errorf("rebuild must not touch containers (container lifecycle belongs to clean), got %q", entry)
			}
		}
	}
}

func TestRunRebuildE_NoDanglingImagesSkipsImagePrune(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{noDangling: true}
	stub.install(t)
	if err := runRebuildE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runRebuildE: %v", err)
	}
	if logIndex(stub.log, "exec:docker image prune") != -1 {
		t.Errorf("no dangling images → docker image prune must be skipped, log: %v", stub.log)
	}
	if logIndex(stub.log, "exec:docker buildx") == -1 {
		t.Errorf("build-cache prune runs regardless, log: %v", stub.log)
	}
}

func TestRunRebuildE_PruneFailureDoesNotFailBuild(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{pruneErr: fmt.Errorf("docker daemon hiccup")}
	stub.install(t)
	stderr := testutil.CaptureStderr(t, func() {
		if err := runRebuildE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runRebuildE: %v", err)
		}
	})
	if !strings.Contains(stderr, "✓ Image built") {
		t.Errorf("prune failure must not fail the rebuild, got %q", stderr)
	}
}

// ──────────────────────────────────────────────
// Phase 4: error paths + boundaries
// ──────────────────────────────────────────────

func TestRunRebuildE_BuildFailureSurfaces(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{buildErr: fmt.Errorf("compose exploded")}
	stub.install(t)
	err := runRebuildE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "docker compose build:") || !strings.Contains(err.Error(), "compose exploded") {
		t.Fatalf("compose failure must wrap as 'docker compose build:', got %v", err)
	}
	if logIndex(stub.log, "exec:docker") != -1 {
		t.Errorf("prunes must be SKIPPED after a failed build, log: %v", stub.log)
	}
}

func TestRunRebuildE_NotAGitRepoSurfaces(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	chdir(t, t.TempDir()) // plain dir, no git worktree

	err := runRebuildE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "not a git repository") {
		t.Fatalf("non-git workdir must surface 'not a git repository', got %v", err)
	}
}

func TestRunRebuildE_WorkdirFlagRespected(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	rootB := buildWorkspaceFixture(t)
	// cwd is a plain non-git dir: if --workdir were ignored, resolveWorkdir
	// would return it and repoRoot would fail loudly.
	chdir(t, t.TempDir())
	buildWorkdir = rootB

	stub := &buildTestStub{}
	stub.install(t)
	if err := runRebuildE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runRebuildE: %v", err)
	}
	if len(stub.compose) != 1 {
		t.Fatalf("expected one compose build, got %d", len(stub.compose))
	}
	env := stub.compose[0].env
	if !slices.Contains(env, "WORKSPACE_HOST_PATH="+rootB) {
		t.Errorf("compose env must target the --workdir workspace, got %v", env)
	}
}

func TestRunRebuildE_DockerCheckRespected(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = false // default: the check runs
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	versionCalls := 0
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "git" {
			return saved(ctx, name, arg...)
		}
		if len(arg) > 0 && arg[0] == "version" {
			versionCalls++
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("28.0.0"), nil }}
		}
		return &mockCmd{runFn: func() error { return nil }} // docker info + compose build
	})
	stubLookPath(t, func(string) (string, error) { return "/usr/bin/docker", nil })
	stubExecCommand(t, func(name string, arg ...string) cmdIface {
		if name == "git" {
			return exec.Command(name, arg...)
		}
		return &mockCmd{}
	})
	stderr := testutil.CaptureStderr(t, func() {
		if err := runRebuildE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runRebuildE: %v", err)
		}
	})
	if versionCalls == 0 {
		t.Error("default rebuild must run the Docker Engine check")
	}
	if !strings.Contains(stderr, "installed and running") {
		t.Errorf("docker check confirmation missing, got %q", stderr)
	}

	// buildNoDockerCheck=true skips the check entirely.
	resetBuildState(t)
	buildNoDockerCheck = true
	versionCalls = 0
	stub := &buildTestStub{}
	stub.install(t)
	if err := runRebuildE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runRebuildE with no-docker-check: %v", err)
	}
	for _, entry := range stub.log {
		if strings.HasPrefix(entry, "run:docker version") || strings.HasPrefix(entry, "run:docker info") {
			t.Errorf("docker check must be skipped with buildNoDockerCheck=true, log: %v", stub.log)
		}
	}
}

// ──────────────────────────────────────────────
// Phase 5: user-journey + docs
// ──────────────────────────────────────────────

func TestRunRebuildE_Journey_OutputFlow(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{}
	stub.install(t)
	stderr := testutil.CaptureStderr(t, func() {
		if err := runRebuildE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runRebuildE: %v", err)
		}
	})

	// Full user-visible sequence: full-rebuild label (distinct from the
	// cached-build label) → image built → prune confirmations.
	if !strings.Contains(stderr, "Building container image (no cache), full rebuild") {
		t.Errorf("rebuild label with full-rebuild marker missing, got %q", stderr)
	}
	if strings.Contains(stderr, "Building container image...\n") {
		t.Errorf("rebuild must not use the plain cached-build label, got %q", stderr)
	}
	if !strings.Contains(stderr, "✓ Image built") {
		t.Errorf("build confirmation missing, got %q", stderr)
	}
	if !strings.Contains(stderr, "✓ Pruned dangling Docker images") {
		t.Errorf("dangling-image prune confirmation missing, got %q", stderr)
	}
	if !strings.Contains(stderr, "✓ Pruned Docker build cache") {
		t.Errorf("build-cache prune confirmation missing, got %q", stderr)
	}
	// No container lifecycle output — that belongs to clean.
	for _, forbidden := range []string{"Killed", "Removed container", "container cheasee-pi"} {
		if strings.Contains(stderr, forbidden) {
			t.Errorf("rebuild must show no container lifecycle output, got %q", stderr)
		}
	}
}

func TestDailyUsageDoc_RebuildCommand(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "daily-usage.md"))
	if err != nil {
		t.Fatalf("reading docs/daily-usage.md: %v", err)
	}
	content := string(data)
	start := strings.Index(content, "### Full rebuild")
	if start == -1 {
		t.Fatal("daily-usage.md must have a '### Full rebuild' section")
	}
	section := content[start:]

	if !strings.Contains(section, "cheasee-pi rebuild") {
		t.Error("the Full rebuild section must list 'cheasee-pi rebuild' as the primary path")
	}
	if !strings.Contains(section, "rebuild = no-cache full rebuild + prune") {
		t.Error("the section must state 'rebuild = no-cache full rebuild + prune' (naming inversion vs VS Code)")
	}
	if !strings.Contains(section, "compatibility") || !strings.Contains(section, "build --no-cache") {
		t.Error("the section must demote 'cheasee-pi build --no-cache' to a compatibility note")
	}
}

func TestDailyUsageDoc_PullClaim(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "daily-usage.md"))
	if err != nil {
		t.Fatalf("reading docs/daily-usage.md: %v", err)
	}
	content := string(data)
	start := strings.Index(content, "### Full rebuild")
	if start == -1 {
		t.Fatal("daily-usage.md must have a '### Full rebuild' section")
	}
	section := content[start:]

	// The base-image-security-use bullet must be served by rebuild's --pull,
	// not by --no-cache alone (--no-cache reuses the locally cached base
	// image; only --pull refreshes it).
	if !strings.Contains(section, "--pull") {
		t.Error("the Full rebuild section must document --pull (base-image refresh)")
	}
	if !strings.Contains(section, "security updates") {
		t.Error("the section must keep the base-image security-updates use case")
	}
}

func TestInstallationDoc_RebuildCommand(t *testing.T) {
	data, err := os.ReadFile(docPath())
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "cheasee-pi rebuild") {
		t.Error("installation.md troubleshooting must list 'cheasee-pi rebuild' as the rebuild path")
	}
}

func TestZedTasks_RebuildCommand(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", ".zed", "tasks.json"))
	if err != nil {
		t.Fatalf("reading .zed/tasks.json: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, `"label": "Cheasee-Pi: rebuild (no cache)"`) {
		t.Error(".zed/tasks.json must keep the rebuild task label")
	}
	if !strings.Contains(content, `"command": "cheasee-pi rebuild"`) {
		t.Error(".zed/tasks.json rebuild task must run 'cheasee-pi rebuild'")
	}
	if strings.Contains(content, `"command": "cheasee-pi build --no-cache"`) {
		t.Error(".zed/tasks.json must not use the legacy 'cheasee-pi build --no-cache' command")
	}
}
