//go:build integration

// Daemon-backed end-to-end harness for the three-service stack. This is the
// repo's first build tag; it is paired with a runtime probe + t.Skip so the
// file is never a hard Docker requirement, and every daemon-free contract
// assertion lives untagged in the default suite (dockerfile_compose_test.go,
// containers_test.go, prune_test.go, up_orphans_test.go). Nothing in this file
// runs under `go test ./cmd/cheasee-pi/` (no tag), `go vet ./...` or coverage.
//
// Run:
//
//	go test -tags integration ./cmd/cheasee-pi/ -run 'TestComposeHarness' -count=1 -timeout 20m
//
// The interactive `pi --approve` exec cannot be driven headlessly, so the
// harness stops at the compose/health boundary that `cheasee-pi start` reaches
// before execing pi — see the Phase-8 boundary noted at startComposeStack.

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

// TestComposeHarness_ThreeServiceStack is the epic's acceptance evidence:
// real containers exist (AC1), the published ports bind loopback only (AC2),
// the terminal ready-marker/pi path is intact (AC3), clean/prune-images
// enumerate the ui artifacts (AC4), and the terminal→UI coexistence contract
// holds across the shared mount (AC5).
func TestComposeHarness_ThreeServiceStack(t *testing.T) {
	requireDockerDaemon(t)

	root := seedComposeHarnessWorkspace(t)
	t.Cleanup(func() { downComposeStack(t, root) })

	started := startComposeStack(t, root)
	ctx := context.Background()

	// ── AC1: the started services exist as real containers ──────────────────
	names, err := projectContainers(ctx, composeProjectName(root))
	if err != nil {
		t.Fatalf("projectContainers(%s): %v", composeProjectName(root), err)
	}
	for _, want := range started {
		if !slices.Contains(names, want) {
			t.Errorf("AC1: %s not among the project's containers %v", want, names)
		}
	}

	// ── AC1/AC4: clean enumerates the managed containers by label ───────────
	managed, err := listManagedContainers(ctx)
	if err != nil {
		t.Fatalf("listManagedContainers: %v", err)
	}
	for _, want := range started {
		if !slices.Contains(managed, want) {
			t.Errorf("AC4: clean must enumerate %s, got %v", want, managed)
		}
	}

	// ── AC2: published ports are loopback-only; the agent publishes none ────
	uiPublished := assertLoopbackPublishedPort(t, uiContainerName(root), "3000/tcp")
	t.Logf("ui published on %s", uiPublished)
	if slices.Contains(started, codeflowContainerName(root)) {
		assertLoopbackPublishedPort(t, codeflowContainerName(root), "8470/tcp")
	}
	if got := dockerOutput(t, "port", containerName(root)); got != "" {
		t.Errorf("AC2: cheasee-pi must publish no ports, `docker port` returned %q", got)
	}

	// ── AC3: the terminal path is unchanged ─────────────────────────────────
	assertContainerHealthy(t, containerName(root))
	// The ready-marker gate: entrypoint setup finished.
	dockerExecOK(t, containerName(root), "test", "-f", "/tmp/.cheasee-pi-ready")
	// pi is reachable inside the agent container (the exec target start uses;
	// the interactive --approve form is asserted untagged in up_env_test.go).
	dockerExecOK(t, containerName(root), "/usr/bin/pi", "--version")

	// ── AC5: a terminal session + its live claim are visible to the ui store ─
	sessionID := "deadbeefcafe"
	sessionDir := filepath.Join(root, ".pi", "sessions")
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf("{\"type\":\"session\",\"id\":%q,\"cwd\":\"/workspaces/main\"}\n", sessionID)
	if err := os.WriteFile(filepath.Join(sessionDir, sessionID+".jsonl"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeInUseClaim(sessionDir, sessionID, containerName(root)); err != nil {
		t.Fatalf("writeInUseClaim: %v", err)
	}
	// The ui sidecar sees both over the shared workspace mount — the store's
	// scan lists the session and the claim drive its in-use guard (the Rust
	// reader contract is pinned untagged in sessions_store.rs).
	for _, path := range []string{
		"/workspaces/main/.pi/sessions/" + sessionID + ".jsonl",
		inUseClaimDir + "/" + sessionID,
	} {
		dockerExecOK(t, uiContainerName(root), "test", "-f", path)
	}

	// ── AC4: prune-images enumerates the ui image ───────────────────────────
	images, err := listCheaseePiImages(ctx)
	if err != nil {
		t.Fatalf("listCheaseePiImages: %v", err)
	}
	uiImage := composeProjectName(root) + "-ui"
	if !slices.ContainsFunc(images, func(img cheaseePiImage) bool {
		return strings.HasPrefix(img.Ref, uiImage+":")
	}) {
		t.Errorf("AC4: prune-images must enumerate %s:*, got %v", uiImage, images)
	}
}

// seedComposeHarnessWorkspace builds a real init-shaped workspace: a worktree
// at <parent>/<slug> with a sibling <parent>/.bare whose origin is the
// deterministic GitHub remote the names derive from. HOST_UID/HOST_GID are
// exported from the test user so the ui sidecar (which runs as that uid/gid)
// can traverse the host-owned config mount and pass its /health probe.
func seedComposeHarnessWorkspace(t *testing.T) string {
	t.Helper()
	t.Setenv("HOST_UID", fmt.Sprint(os.Getuid()))
	t.Setenv("HOST_GID", fmt.Sprint(os.Getgid()))

	src := gitRemoteFixture(t, "main")
	parent := t.TempDir()
	root := filepath.Join(parent, "cli-install-smoke")
	bareDir := cloneWorktreeLayout(t, src, parent, root)
	// Deterministic GitHub remote so the derived slug is stable across runs.
	runGit(t, "--git-dir", bareDir, "config", "remote.origin.url",
		"https://github.com/SchneiderDaniel/cli-install-smoke.git")
	testutil.WriteCheaseeSettingsFile(t, root, "{}")
	return root
}

// startComposeStack brings the stack up through the production start path
// (ensureContainerReady = cache extract + compose up + ready-marker gate) and
// returns the container names that were started. On the DinD CI daemon the
// codeflow service's ./codeflow/config.json bind cannot resolve (auto-created
// as a directory -> ENOTDIR), so the harness falls back to the agent+ui subset
// exactly as docker/test/cli-install-smoke.test.mts checkpoint 5 does; codeflow
// remains covered by the daemon-free resolved-compose assertions.
func startComposeStack(t *testing.T, root string) []string {
	t.Helper()
	ctx := context.Background()

	if _, err := ensureContainerReady(ctx, root, containerName(root), false); err == nil {
		return []string{containerName(root), codeflowContainerName(root), uiContainerName(root)}
	} else {
		t.Logf("full compose up failed (%v) — retrying the agent+ui subset (DinD codeflow bind)", err)
	}

	cacheDir, err := ensureCacheDir(ctx)
	if err != nil {
		t.Fatalf("cache dir: %v", err)
	}
	if err := NewExtractor().Extract(ctx, cacheDir); err != nil {
		t.Fatalf("extract compose files: %v", err)
	}
	if err := composeUpSubset(ctx, cacheDir, root, "cheasee-pi", "ui"); err != nil {
		t.Fatalf("compose up (agent+ui subset): %v", err)
	}
	if err := waitHealthy(ctx, containerName(root)); err != nil {
		t.Fatalf("wait for agent readiness: %v", err)
	}
	return []string{containerName(root), uiContainerName(root)}
}

// composeUpSubset starts a named subset of the embedded compose services with
// the same env contract applyComposeEnv installs for `cheasee-pi start`.
func composeUpSubset(ctx context.Context, cacheDir, root string, services ...string) error {
	args := append([]string{
		"compose", "-f", filepath.Join(cacheDir, "docker-compose.yml"),
		"up", "-d", "--remove-orphans",
	}, services...)
	cmd := runCommandContext(ctx, "docker", args...)
	cmd.SetStdout(os.Stderr)
	cmd.SetStderr(os.Stderr)
	applyComposeEnv(cmd, root, containerName(root), cacheDir)
	return cmd.Run()
}

// downComposeStack tears the project down (containers, volumes, local images)
// even when an assertion failed — no leaked containers or images.
func downComposeStack(t *testing.T, root string) {
	t.Helper()
	ctx := context.Background()
	cacheDir, err := ensureCacheDir(ctx)
	if err != nil {
		t.Logf("teardown skipped (cache dir: %v)", err)
		return
	}
	if err := NewExtractor().Extract(ctx, cacheDir); err != nil {
		t.Logf("teardown skipped (extract: %v)", err)
		return
	}
	cmd := runCommandContext(ctx, "docker", "compose",
		"-p", composeProjectName(root),
		"-f", filepath.Join(cacheDir, "docker-compose.yml"),
		"down", "-v", "--rmi", "local",
	)
	applyComposeEnv(cmd, root, containerName(root), cacheDir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Logf("teardown `compose down`: %v\n%s", err, out)
	}
}

// assertLoopbackPublishedPort returns the host:port spec for a published
// port and fails when the host side is not IPv4 loopback (AC2).
func assertLoopbackPublishedPort(t *testing.T, name, port string) string {
	t.Helper()
	spec := dockerOutput(t, "port", name, port)
	host, _, ok := strings.Cut(spec, ":")
	if !ok || spec == "" {
		t.Fatalf("`docker port %s %s` returned %q, want a host:port spec", name, port, spec)
	}
	if host != "127.0.0.1" {
		t.Errorf("AC2: %s published %s on %q, want 127.0.0.1 only", name, port, host)
	}
	return spec
}

func assertContainerHealthy(t *testing.T, name string) {
	t.Helper()
	if status := dockerOutput(t, "inspect", "--format", "{{.State.Health.Status}}", name); status != "healthy" {
		t.Errorf("AC3: %s health = %q, want healthy", name, status)
	}
}

func dockerExecOK(t *testing.T, name string, args ...string) {
	t.Helper()
	full := append([]string{"exec", name}, args...)
	if out, err := runCommandContext(context.Background(), "docker", full...).CombinedOutput(); err != nil {
		t.Fatalf("docker exec %s %v: %v\n%s", name, args, err, out)
	}
}

// dockerOutput runs a docker command through the production seam and returns
// trimmed stdout, failing on any non-zero exit (no partial-as-success).
func dockerOutput(t *testing.T, args ...string) string {
	t.Helper()
	out, err := runCommandContext(context.Background(), "docker", args...).Output()
	if err != nil {
		t.Fatalf("docker %v: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}
