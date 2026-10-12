package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// uniqueHarnessSlug returns a per-run project slug that satisfies Compose's
// name charset (^[a-z0-9][a-z0-9_-]*$) and can never collide with another run.
func uniqueHarnessSlug(t *testing.T) string {
	t.Helper()
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("generate unique harness slug: %v", err)
	}
	return "compose-harness-" + hex.EncodeToString(b[:])
}

// requireProjectClean fails the test closed when the fixture's unique compose
// project already has containers: it must never adopt a stack this run did not
// create (and whose teardown/cleanup would then delete foreign resources).
func requireProjectClean(t *testing.T, root string) {
	t.Helper()
	project := composeProjectName(root)
	names, err := projectContainers(context.Background(), project)
	if err != nil {
		t.Fatalf("pre-flight: enumerate project %s: %v", project, err)
	}
	if len(names) > 0 {
		t.Fatalf("pre-flight: project %s already has containers %v — refusing to run against a pre-existing stack", project, names)
	}
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

	// Capture stderr so a failure can be classified rather than guessed: the
	// production seam writes the daemon's error text to os.Stderr while
	// returning a bare "exit status 1".
	var upErr error
	output := testutil.CaptureStderr(t, func() {
		_, upErr = ensureContainerReady(ctx, root, containerName(root), false)
	})
	if upErr == nil {
		return []string{containerName(root), codeflowContainerName(root), uiContainerName(root)}
	}
	// Fall back ONLY for the one environmental failure this harness may route
	// around: the codeflow service's ./codeflow/config.json bind cannot resolve
	// on a remote/DinD daemon (auto-created as a directory -> ENOTDIR on mount),
	// the limitation documented by docker/test/cli-install-smoke.test.mts
	// checkpoint 5. Any other failure is real — a codeflow regression must not
	// pass just because agent+ui happened to start.
	if !isCodeflowBindUnavailable(output) {
		t.Fatalf("compose up failed (not the known remote-daemon codeflow bind limitation): %v\n%s", upErr, output)
	}
	// The string signature alone must not authorize the fallback: a missing or
	// non-file embedded codeflow/config.json produces a similarly-shaped mount
	// error and would wrongly route around a real failure. Verify the two
	// preconditions that make the fallback legitimate — the daemon is remote (it
	// genuinely cannot see this host's extracted cache) and the extracted
	// config exists locally as a regular file.
	cacheDir, err := ensureCacheDir(ctx)
	if err != nil {
		t.Fatalf("cache dir: %v", err)
	}
	if err := NewExtractor().Extract(ctx, cacheDir); err != nil {
		t.Fatalf("extract compose files: %v", err)
	}
	requireRemoteDaemonCodeflowFallback(t, cacheDir)
	t.Logf("codeflow bind unavailable on this daemon (%v) — starting the agent+ui subset", upErr)

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
// even when an assertion failed — no leaked containers or images. It only
// touches resources verified as created by this test: a unique project with no
// containers never came up (nothing to tear down), and every container in the
// project must be one of the fixture's three service containers.
func downComposeStack(t *testing.T, root string) {
	t.Helper()
	ctx := context.Background()
	project := composeProjectName(root)

	names, err := projectContainers(ctx, project)
	if err != nil {
		t.Logf("teardown skipped (enumerate %s: %v)", project, err)
		return
	}
	if len(names) == 0 {
		return // the stack never started; nothing this test created
	}
	allowed := map[string]bool{
		containerName(root):         true,
		codeflowContainerName(root): true,
		uiContainerName(root):       true,
	}
	for _, n := range names {
		if !allowed[n] {
			t.Errorf("teardown: project %s holds unexpected container %q — refusing to tear it down", project, n)
			return
		}
	}

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
		"-p", project,
		"-f", filepath.Join(cacheDir, "docker-compose.yml"),
		"down", "-v", "--rmi", "local",
	)
	applyComposeEnv(cmd, root, containerName(root), cacheDir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Logf("teardown `compose down`: %v\n%s", err, out)
	}
}

// isCodeflowBindUnavailable recognizes the remote-daemon bind failure the
// harness may route around: the codeflow service's ./codeflow/config.json bind
// source cannot resolve on the daemon (Docker auto-creates the path as a
// directory -> ENOTDIR on mount). It requires the codeflow service AND its
// config.json path AND a mount keyword, so an unrelated compose error (bad
// image, port conflict, build failure) can never be mistaken for the known
// limitation; the caller additionally verifies the remote-daemon and
// local-config preconditions before trusting this signature.
func isCodeflowBindUnavailable(output string) bool {
	l := strings.ToLower(output)
	if !strings.Contains(l, "codeflow") || !strings.Contains(l, "config.json") {
		return false
	}
	for _, kw := range []string{"mount", "bind", "create_host_path", "not a directory", "enotdir"} {
		if strings.Contains(l, kw) {
			return true
		}
	}
	return false
}

// requireRemoteDaemonCodeflowFallback fails (never skips) unless the two
// preconditions that make the codeflow-bind fallback legitimate hold: the
// Docker daemon is remote — so it genuinely cannot see this host's extracted
// cache dir — and the extracted codeflow/config.json exists locally as a
// regular file. Without both, a codeflow bind failure is a real regression
// (missing embedded config, local path problem) and must fail the test rather
// than be silently routed around.
func requireRemoteDaemonCodeflowFallback(t *testing.T, cacheDir string) {
	t.Helper()
	if !isRemoteDockerHost(os.Getenv("DOCKER_HOST")) {
		t.Fatalf("codeflow bind failed but the Docker daemon is local (DOCKER_HOST=%q) — not the known remote-daemon limitation; failing instead of falling back", os.Getenv("DOCKER_HOST"))
	}
	config := filepath.Join(cacheDir, codeflowConfigJSON)
	info, err := os.Stat(config)
	if err != nil {
		t.Fatalf("extracted codeflow config %s is unavailable (%v) — the fallback must not mask a missing embedded config", config, err)
	}
	if !info.Mode().IsRegular() {
		t.Fatalf("extracted codeflow config %s is not a regular file (%s)", config, info.Mode())
	}
}

// isRemoteDockerHost reports whether DOCKER_HOST points at a remote daemon (a
// non-unix scheme). Only then can a codeflow config bind legitimately fail
// because the daemon cannot see the test host's filesystem — an unset/empty or
// unix-socket DOCKER_HOST is local, so a bind failure there is a real bug.
func isRemoteDockerHost(host string) bool {
	host = strings.TrimSpace(host)
	for _, scheme := range []string{"tcp://", "ssh://", "http://", "https://"} {
		if strings.HasPrefix(host, scheme) {
			return true
		}
	}
	return false
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
	if out, err := dockerExecOutput(t, name, args...); err != nil {
		t.Fatalf("docker exec %s %v: %v\n%s", name, args, err, out)
	}
}

// dockerExecOutput runs a command in a container and returns its combined
// output plus the exit error — the caller decides whether a non-zero exit is
// the assertion under test.
func dockerExecOutput(t *testing.T, name string, args ...string) (string, error) {
	t.Helper()
	full := append([]string{"exec", name}, args...)
	out, err := runCommandContext(context.Background(), "docker", full...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
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
