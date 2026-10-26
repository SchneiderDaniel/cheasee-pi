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
)

// ──────────────────────────────────────────────
// Phases 4-5: stack executor (ensureStackUp)
// ──────────────────────────────────────────────

// stackFixture pins the hermetic workspace + seams an ensureStackUp test
// needs: derived identity from a real bare remote, a temp cache dir, and the
// docker/git seam from stubReadyFlow (states/imageRefs/starts captured).
func stackFixture(t *testing.T) (root, name, cacheDir string, c *upCapture) {
	t.Helper()
	return stackFixtureWith(t, func(context.Context, []string) runner { return &mockCmd{} })
}

// stackFixtureWith is stackFixture with a caller-supplied docker write-path
// stub (used to inject start/build/up failures).
func stackFixtureWith(t *testing.T, dockerFn func(context.Context, []string) runner) (root, name, cacheDir string, c *upCapture) {
	t.Helper()
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/foo.git")
	setUpReady(t)
	return root, containerName(root), t.TempDir(), stubReadyFlow(t, root, dockerFn)
}

// failingDocker makes dockerFn fail the calls the predicate matches.
func failingDocker(match func(arg []string) bool) func(context.Context, []string) runner {
	return func(_ context.Context, arg []string) runner {
		if !match(arg) {
			return &mockCmd{}
		}
		err := fmt.Errorf("docker %s failed", strings.Join(arg, " "))
		return &mockCmd{
			outputFn:   func() ([]byte, error) { return nil, err },
			combinedFn: func() ([]byte, error) { return nil, err },
			runFn:      func() error { return err },
		}
	}
}

func TestEnsureStackUp_allRunningTouchesNothing(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	c.states = map[string]string{
		services[0].container: "running",
		services[1].container: "running",
		services[2].container: "running",
	}
	c.imageRefs = map[string]bool{}

	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	if len(c.starts) != 0 {
		t.Errorf("running containers must not be started, got %v", c.starts)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("running stack must skip compose, got %v", c.composeArgs)
	}
	if len(c.imageProbes) != 0 {
		t.Errorf("running stack must not probe images, got %v", c.imageProbes)
	}
}

func TestEnsureStackUp_stoppedContainersStartWithoutCompose(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	c.states = map[string]string{
		services[0].container: "exited",
		services[1].container: "exited",
		services[2].container: "exited",
	}
	c.imageRefs = map[string]bool{}

	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	wantStarts := []string{services[0].container, services[1].container, services[2].container}
	if !slices.Equal(c.starts, wantStarts) {
		t.Errorf("starts = %v, want %v (stack order)", c.starts, wantStarts)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("starting existing containers must not touch compose, got %v", c.composeArgs)
	}
	if len(c.imageProbes) != 0 {
		t.Errorf("existing containers need no image probe, got %v", c.imageProbes)
	}
}

func TestEnsureStackUp_startFailureFailsFast(t *testing.T) {
	root, name, cacheDir, c := stackFixtureWith(t, failingDocker(func(arg []string) bool {
		return len(arg) > 1 && arg[0] == "start" && strings.Contains(arg[1], "codeflow")
	}))
	services := stackServices(root)
	c.states = map[string]string{
		services[0].container: "running",
		services[1].container: "exited",
		services[2].container: "exited",
	}
	c.imageRefs = map[string]bool{}
	codeflowContainer := services[1].container

	err := ensureStackUp(context.Background(), cacheDir, root, name)
	if err == nil || !strings.Contains(err.Error(), "start container "+codeflowContainer) {
		t.Fatalf("start failure must surface naming the container, got %v", err)
	}
	if len(c.starts) != 1 {
		t.Errorf("fail-fast: ui must not start after codeflow failed, got %v", c.starts)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("start failure must never fall back to compose, got %v", c.composeArgs)
	}
}

func TestEnsureStackUp_stateProbeFailureFailsClosed(t *testing.T) {
	root, name, cacheDir, c := stackFixtureWith(t, failingDocker(func(arg []string) bool {
		return slices.Contains(arg, "ps")
	}))

	err := ensureStackUp(context.Background(), cacheDir, root, name)
	if err == nil || !strings.Contains(err.Error(), "docker ps:") {
		t.Fatalf("probe failure must surface, got %v", err)
	}
	if len(c.starts) != 0 {
		t.Errorf("no start after a failed probe, got %v", c.starts)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("no compose after a failed probe, got %v", c.composeArgs)
	}
}

func TestEnsureStackUp_missingContainerImagePresentCreatesOnly(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	c.states = map[string]string{
		services[0].container: "running",
		services[1].container: "running",
	}
	c.imageRefs = map[string]bool{services[2].image: true}

	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	if !slices.Equal(c.imageProbes, []string{services[2].image}) {
		t.Errorf("image probes = %v, want only the missing ui image %q", c.imageProbes, services[2].image)
	}
	if len(c.starts) != 0 {
		t.Errorf("running containers must not be started, got %v", c.starts)
	}
	if len(c.composeArgs) != 1 {
		t.Fatalf("image present → exactly one compose call (create), got %v", c.composeArgs)
	}
	got := c.composeArgs[0]
	if slices.Contains(got, "build") {
		t.Errorf("present image must not be rebuilt, got %v", got)
	}
	for _, want := range []string{"up", "-d", "--remove-orphans", "--no-build", "--pull", "never"} {
		if !slices.Contains(got, want) {
			t.Errorf("create argv must carry %q, got %v", want, got)
		}
	}
	if got[len(got)-1] != "ui" || slices.Contains(got, "cheasee-pi") || slices.Contains(got, "codeflow") {
		t.Errorf("create argv must target only the missing service, got %v", got)
	}
	composeFile := filepath.Join(cacheDir, "docker-compose.yml")
	if !slices.Contains(got, "-f") || !slices.Contains(got, composeFile) {
		t.Errorf("create argv must -f %s, got %v", composeFile, got)
	}
	if !slices.Contains(c.composeCmds[0].env, "WORKSPACE_HOST_PATH="+root) {
		t.Errorf("create env must carry WORKSPACE_HOST_PATH=%s, got %v", root, c.composeCmds[0].env)
	}
}

func TestEnsureStackUp_missingImageBuildsScopedThenCreates(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	c.states = map[string]string{services[0].container: "running"}
	c.imageRefs = map[string]bool{services[1].image: false, services[2].image: true}

	stderr := testutil.CaptureStderr(t, func() {
		if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
			t.Fatalf("ensureStackUp: %v", err)
		}
	})
	if len(c.composeArgs) != 2 {
		t.Fatalf("absent image + missing container → build then create, got %v", c.composeArgs)
	}
	build, create := c.composeArgs[0], c.composeArgs[1]
	if !slices.Contains(build, "build") {
		t.Errorf("first compose call must build, got %v", build)
	}
	for _, unwanted := range []string{"--no-cache", "--pull", "cheasee-pi", "ui"} {
		if slices.Contains(build, unwanted) {
			t.Errorf("scoped build must not carry %q, got %v", unwanted, build)
		}
	}
	if build[len(build)-1] != "codeflow" {
		t.Errorf("scoped build must target codeflow only, got %v", build)
	}
	servicesArgv := create[len(create)-2:]
	if !slices.Contains(create, "up") || !slices.Equal(servicesArgv, []string{"codeflow", "ui"}) {
		t.Errorf("create must target exactly the two missing services, got %v", create)
	}
	if strings.Contains(stderr, "First start downloads") {
		t.Errorf("agent image present → no first-build notice, got %q", stderr)
	}
}

func TestEnsureStackUp_fullMissingStackBuildsAbsentAndCreatesAll(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	c.states = nil
	c.imageRefs = map[string]bool{services[0].image: true, services[1].image: true}

	stderr := testutil.CaptureStderr(t, func() {
		if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
			t.Fatalf("ensureStackUp: %v", err)
		}
	})
	if len(c.composeArgs) != 2 {
		t.Fatalf("one scoped build + one create, got %v", c.composeArgs)
	}
	build, create := c.composeArgs[0], c.composeArgs[1]
	if want := []string{"build", "ui"}; build[len(build)-2] != want[0] || build[len(build)-1] != want[1] {
		t.Errorf("build must target only the absent ui image, got %v", build)
	}
	servicesArgv := create[len(create)-3:]
	if !slices.Equal(servicesArgv, []string{"cheasee-pi", "codeflow", "ui"}) {
		t.Errorf("create must target the whole stack in order, got %v", create)
	}
	if strings.Contains(stderr, "First start downloads") {
		t.Errorf("agent image present → no first-build notice, got %q", stderr)
	}
}

func TestEnsureStackUp_noImagesPrintsFirstBuildNoticeOnce(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	c.states = nil
	c.imageRefs = map[string]bool{}

	stderr := testutil.CaptureStderr(t, func() {
		if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
			t.Fatalf("ensureStackUp: %v", err)
		}
	})
	if len(c.composeArgs) != 2 {
		t.Fatalf("all images absent → one build + one create, got %v", c.composeArgs)
	}
	build := c.composeArgs[0]
	gotServices := build[len(build)-3:]
	if !slices.Equal(gotServices, []string{"cheasee-pi", "codeflow", "ui"}) {
		t.Errorf("all-services build must target the stack in order, got %v", build)
	}
	if n := strings.Count(stderr, "First start downloads"); n != 1 {
		t.Errorf("notice must appear exactly once, got %d in %q", n, stderr)
	}
	i, j := strings.Index(stderr, "First start downloads"), strings.Index(stderr, "Building container image...")
	if i < 0 || j < 0 || i > j {
		t.Errorf("notice (idx %d) must precede the build label (idx %d), stderr %q", i, j, stderr)
	}
}

func TestEnsureStackUp_buildFailureNeverCreates(t *testing.T) {
	root, name, cacheDir, c := stackFixtureWith(t, failingDocker(func(arg []string) bool {
		return slices.Contains(arg, "build")
	}))
	c.states = nil
	c.imageRefs = map[string]bool{}

	err := ensureStackUp(context.Background(), cacheDir, root, name)
	if err == nil {
		t.Fatal("a failed build must surface")
	}
	if len(c.composeCmds) != 1 || !slices.Contains(c.composeArgs[0], "build") {
		t.Errorf("no create after a failed build, got %v", c.composeArgs)
	}
}

func TestEnsureStackUp_createFailureIsNotRetried(t *testing.T) {
	root, name, cacheDir, c := stackFixtureWith(t, failingDocker(func(arg []string) bool {
		return slices.Contains(arg, "up")
	}))
	services := stackServices(root)
	c.imageRefs = map[string]bool{services[0].image: true, services[1].image: true, services[2].image: true}

	err := ensureStackUp(context.Background(), cacheDir, root, name)
	if err == nil {
		t.Fatal("a failed create must surface")
	}
	if len(c.composeArgs) != 1 {
		t.Errorf("failed create must not be retried nor followed by a build, got %v", c.composeArgs)
	}
}

func TestEnsureStackUp_commitRecordOnlyForAgentBuild(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	record := cheaseeCommitCachePath(cacheDir, cheaseeImageRef(root))

	// Sidecar-only build: the agent image is not built, so no commit record.
	c.states = map[string]string{services[0].container: "running"}
	c.imageRefs = map[string]bool{services[1].image: false, services[2].image: true}
	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	if _, err := os.Stat(record); !os.IsNotExist(err) {
		t.Errorf("sidecar-only build must not record the agent commit, got %v", err)
	}

	// Agent build: the commit record is written.
	c2 := stubReadyFlow(t, root, func(context.Context, []string) runner { return &mockCmd{} })
	c2.states = nil
	c2.imageRefs = map[string]bool{}
	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	if _, err := os.Stat(record); err != nil {
		t.Errorf("agent build must record the baked commit, got %v", err)
	}
}

func TestEnsureStackUp_neverPullsAndEveryUpUsesPullNever(t *testing.T) {
	// Exhaustive over the two compose-bearing plans: no `pull` subcommand is
	// ever issued, and every `up` argv carries `--pull never` so compose can
	// never reach a registry for a missing image.
	root, name, _, c := stackFixture(t)
	c.states = nil
	c.imageRefs = map[string]bool{}

	if err := ensureStackUp(context.Background(), t.TempDir(), root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	if len(c.composeArgs) == 0 {
		t.Fatal("expected compose invocations")
	}
	for _, args := range c.composeArgs {
		if slices.Contains(args, "pull") {
			t.Errorf("start must never run a compose pull, got %v", args)
		}
		if slices.Contains(args, "up") {
			i := slices.Index(args, "--pull")
			if i < 0 || i+1 >= len(args) || args[i+1] != "never" {
				t.Errorf("every up argv must carry `--pull never`, got %v", args)
			}
			if !slices.Contains(args, "--no-build") {
				t.Errorf("every create argv must carry `--no-build`, got %v", args)
			}
		}
	}
}
