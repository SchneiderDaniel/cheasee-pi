package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// ──────────────────────────────────────────────
// Seams for the disk-space gate
// ──────────────────────────────────────────────

// stubDockerInfoRoot stubs the exec seam to answer the DockerRootDir probe
// (and only that). out is returned verbatim; err, when non-nil, replaces the
// probe output with a failure.
func stubDockerInfoRoot(t *testing.T, out string, err error) {
	t.Helper()
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "{{.DockerRootDir}}") {
			if err != nil {
				return &mockCmd{outputFn: func() ([]byte, error) { return nil, err }}
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(out), nil }}
		}
		return &mockCmd{}
	})
}

// stubStatfs replaces the free-space probe seam for the duration of the test.
// Serialized like the other package-var seams.
func stubStatfs(t *testing.T, fn func(string) (uint64, error)) {
	t.Helper()
	saved := statfsFn
	statfsFn = fn
	t.Cleanup(func() { statfsFn = saved })
}

// stubStatfsAmple sets the probe above the build threshold so a build-running
// harness never trips the disk gate.
func stubStatfsAmple(t *testing.T) {
	t.Helper()
	stubStatfs(t, func(string) (uint64, error) { return uint64(minBuildFreeBytes + 1), nil })
}

func stubStatfsBytes(t *testing.T, n uint64) {
	t.Helper()
	stubStatfs(t, func(string) (uint64, error) { return n, nil })
}

// recordCompose stubs the docker seam: the data-root probe answers root,
// compose invocations are counted, everything else is a silent success.
func recordCompose(t *testing.T, root string) *int {
	t.Helper()
	n := 0
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "{{.DockerRootDir}}") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(root + "\n"), nil }}
		}
		if name == "docker" && slices.Contains(arg, "compose") {
			n++
		}
		return &mockCmd{}
	})
	return &n
}

// ──────────────────────────────────────────────
// Phase 1: policy adapter
// ──────────────────────────────────────────────

func TestCheckBuildDiskSpace_AboveThreshold_NoError(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	stubStatfsBytes(t, uint64(minBuildFreeBytes)+1)
	if err := checkBuildDiskSpace(context.Background()); err != nil {
		t.Fatalf("free space above the threshold must pass, got %v", err)
	}
}

func TestCheckBuildDiskSpace_AtThreshold_NoError(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	stubStatfsBytes(t, uint64(minBuildFreeBytes))
	if err := checkBuildDiskSpace(context.Background()); err != nil {
		t.Fatalf("exactly the threshold must pass (boundary is <), got %v", err)
	}
}

func TestCheckBuildDiskSpace_BelowThreshold_ActionableError(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)
	err := checkBuildDiskSpace(context.Background())
	if err == nil {
		t.Fatal("free space below the threshold must refuse the build")
	}
	for _, want := range []string{"GiB", "10", "/var/lib/docker", "cheasee-pi clean", "cheasee-pi prune-images"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("refusal must name %q, got %v", want, err)
		}
	}
}

func TestCheckBuildDiskSpace_ZeroFree_Refuses(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	stubStatfsBytes(t, 0)
	err := checkBuildDiskSpace(context.Background())
	if err == nil {
		t.Fatal("zero free space must refuse the build")
	}
	if strings.Contains(err.Error(), "NaN") || strings.Contains(err.Error(), "Inf") {
		t.Errorf("zero-free refusal must format cleanly, got %v", err)
	}
}

func TestCheckBuildDiskSpace_StatfsError_FailsOpen(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	stubStatfs(t, func(string) (uint64, error) { return 0, fmt.Errorf("statfs boom") })
	stderr := testutil.CaptureStderr(t, func() {
		if err := checkBuildDiskSpace(context.Background()); err != nil {
			t.Fatalf("undeterminable free space must fail open, got %v", err)
		}
	})
	if !strings.Contains(stderr, "skipping the build free-space check") {
		t.Errorf("statfs failure must warn on stderr, got %q", stderr)
	}
}

func TestCheckBuildDiskSpace_DataRootError_FailsOpen(t *testing.T) {
	stubDockerInfoRoot(t, "", fmt.Errorf("daemon down"))
	// Zero free: if the gate probed the disk anyway, it would refuse.
	stubStatfsBytes(t, 0)
	stderr := testutil.CaptureStderr(t, func() {
		if err := checkBuildDiskSpace(context.Background()); err != nil {
			t.Fatalf("unresolvable data root must fail open, got %v", err)
		}
	})
	if !strings.Contains(stderr, "skipping the build free-space check") {
		t.Errorf("data-root failure must warn on stderr, got %q", stderr)
	}
}

func TestCheckBuildDiskSpace_EmptyDataRoot_FailsOpen(t *testing.T) {
	stubDockerInfoRoot(t, "   \n", nil)
	stubStatfsBytes(t, 0)
	stderr := testutil.CaptureStderr(t, func() {
		if err := checkBuildDiskSpace(context.Background()); err != nil {
			t.Fatalf("empty data root must fail open, got %v", err)
		}
	})
	if !strings.Contains(stderr, "skipping the build free-space check") {
		t.Errorf("empty data root must warn on stderr, got %q", stderr)
	}
}

func TestDockerDataRoot_TrimsWhitespace(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	root, err := dockerDataRoot(context.Background())
	if err != nil || root != "/var/lib/docker" {
		t.Fatalf("dockerDataRoot = %q, %v; want /var/lib/docker", root, err)
	}
}

func TestDockerDataRoot_StatfsReceivesResolvedPath(t *testing.T) {
	stubDockerInfoRoot(t, "/var/lib/docker\n", nil)
	var got string
	stubStatfs(t, func(p string) (uint64, error) { got = p; return uint64(minBuildFreeBytes), nil })
	if err := checkBuildDiskSpace(context.Background()); err != nil {
		t.Fatalf("checkBuildDiskSpace: %v", err)
	}
	if got != "/var/lib/docker" {
		t.Errorf("statfsFn received %q, want the resolved data root", got)
	}
}

func TestMinBuildFreeBytes_DocumentedThreshold(t *testing.T) {
	if minBuildFreeBytes != 10<<30 {
		t.Errorf("minBuildFreeBytes = %d, want the documented 10 GiB (10<<30)", minBuildFreeBytes)
	}
}

// ──────────────────────────────────────────────
// Phase 2: build choke point
// ──────────────────────────────────────────────

func TestComposeBuild_LowDiskRefusedBeforeRun(t *testing.T) {
	composeRuns := recordCompose(t, "/var/lib/docker")
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)
	err := composeBuild(context.Background(), t.TempDir(), t.TempDir(), "cheasee-pi-x", composeBuildSpec{label: "Building container image"})
	if err == nil || !strings.Contains(err.Error(), "cheasee-pi clean") {
		t.Fatalf("low free space must refuse with the reclaim hint, got %v", err)
	}
	if *composeRuns != 0 {
		t.Errorf("refused build must not invoke docker compose, got %d", *composeRuns)
	}
}

func TestComposeBuild_LowDiskErrorNotWrapped(t *testing.T) {
	recordCompose(t, "/var/lib/docker")
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)
	err := composeBuild(context.Background(), t.TempDir(), t.TempDir(), "cheasee-pi-x", composeBuildSpec{
		label:   "Building container image",
		wrapErr: func(e error) error { return fmt.Errorf("docker compose build: %w", e) },
	})
	if err == nil || strings.Contains(err.Error(), "docker compose build:") {
		t.Fatalf("disk refusal must not be wrapped as a compose failure, got %v", err)
	}
}

func TestComposeBuild_AmpleDisk_OneComposeInvocation(t *testing.T) {
	composeRuns := recordCompose(t, "/var/lib/docker")
	stubStatfsBytes(t, uint64(minBuildFreeBytes))
	stderr := testutil.CaptureStderr(t, func() {
		if err := composeBuild(context.Background(), t.TempDir(), t.TempDir(), "cheasee-pi-x", composeBuildSpec{label: "Building container image"}); err != nil {
			t.Fatalf("ample free space must build, got %v", err)
		}
	})
	if *composeRuns != 1 {
		t.Errorf("ample free space must run exactly one compose build, got %d", *composeRuns)
	}
	if !strings.Contains(stderr, "Building container image") {
		t.Errorf("label missing, got %q", stderr)
	}
}

func TestRunBuildE_LowDisk_NoCompose(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	chdir(t, buildWorkspaceFixture(t))

	stub := &buildTestStub{}
	stub.install(t)
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)

	err := runBuildE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "cheasee-pi clean") {
		t.Fatalf("cached build below the threshold must refuse, got %v", err)
	}
	if len(stub.compose) != 0 {
		t.Errorf("refused build must not run compose, got %d", len(stub.compose))
	}
}

func TestRunRebuildE_LowDisk_NoComposeNoPrune(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	chdir(t, buildWorkspaceFixture(t))

	stub := &buildTestStub{}
	stub.install(t)
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)

	err := runRebuildE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "cheasee-pi clean") {
		t.Fatalf("no-cache rebuild below the threshold must refuse, got %v", err)
	}
	if len(stub.log) != 0 {
		t.Errorf("refused rebuild must run no docker command, got %v", stub.log)
	}
}

func TestRunBuildE_LowDiskRefusedWithNoDockerCheck(t *testing.T) {
	// --no-docker-check skips the availability gate, never the capacity gate.
	resetBuildState(t)
	buildNoDockerCheck = true
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	chdir(t, buildWorkspaceFixture(t))

	stub := &buildTestStub{}
	stub.install(t)
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)

	err := runBuildE(&cobra.Command{}, nil)
	if err == nil || !strings.Contains(err.Error(), "not enough free space") {
		t.Fatalf("the disk gate must be independent of --no-docker-check, got %v", err)
	}
	if len(stub.compose) != 0 {
		t.Errorf("refused build must not run compose, got %d", len(stub.compose))
	}
}

// ──────────────────────────────────────────────
// Phase 3: start-path transitivity
// ──────────────────────────────────────────────

func TestDockerComposeUp_LowDiskRefusesBeforeCompose(t *testing.T) {
	// The bug's start-triggered rebuild: ensureContainerReady → dockerComposeUp
	// → composeBuild must inherit the gate, so no compose up ever runs.
	_, root := mkWorkspace(t, `{}`)
	setUpReady(t)

	c := stubReadyFlow(t, root, func(_ context.Context, arg []string) runner {
		if slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(""), nil }}
		}
		return &mockCmd{}
	})
	stubStatfsBytes(t, uint64(minBuildFreeBytes)-1)

	_, err := ensureContainerReady(context.Background(), root, containerName(root), false)
	if err == nil || !strings.Contains(err.Error(), "cheasee-pi clean") {
		t.Fatalf("start-path rebuild must refuse on low disk, got %v", err)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("refused start must not invoke compose, got %v", c.composeArgs)
	}
}

// ──────────────────────────────────────────────
// Phase 4: platform probe smoke
// ──────────────────────────────────────────────

func TestPlatformFreeBytes_TempDir(t *testing.T) {
	free, err := platformFreeBytes(t.TempDir())
	if err != nil {
		t.Fatalf("platformFreeBytes: %v", err)
	}
	if free == 0 {
		t.Error("expected >0 free bytes on a real temp dir")
	}
}

// ──────────────────────────────────────────────
// Phase 5: docs contract
// ──────────────────────────────────────────────

func TestInstallationDoc_BuildDisk(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "installation.md"))
	if err != nil {
		t.Fatalf("reading docs/installation.md: %v", err)
	}
	content := string(data)
	for _, want := range []string{"10 GiB", "DockerRootDir", "cheasee-pi clean", "cheasee-pi prune-images"} {
		if !strings.Contains(content, want) {
			t.Errorf("installation.md must document %q in the build disk-space contract", want)
		}
	}
}

func TestCLIDoc_BuildDisk(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "cli.md"))
	if err != nil {
		t.Fatalf("reading docs/cli.md: %v", err)
	}
	start := strings.Index(string(data), "## `cheasee-pi build` / `rebuild`")
	if start == -1 {
		t.Fatal("cli.md must have a build/rebuild section")
	}
	section := string(data)[start:]
	if end := strings.Index(section[1:], "\n## "); end != -1 {
		section = section[:end+1]
	}
	for _, want := range []string{"10 GiB", "free space", "cheasee-pi clean", "cheasee-pi prune-images"} {
		if !strings.Contains(section, want) {
			t.Errorf("cli.md build/rebuild section must name %q", want)
		}
	}
}
