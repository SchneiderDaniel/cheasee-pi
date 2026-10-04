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
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
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

	// The agent gate in startComposeStack covers cheasee-pi only; the ui
	// sidecar has its own /health probe, so wait for it before driving its
	// session API (the store scan the probe reads is not ready until then).
	if err := waitHealthy(ctx, uiContainerName(root)); err != nil {
		t.Fatalf("ui not healthy: %v", err)
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

	// ── AC5: a terminal session + its live claim are listed by the running ui,
	//        which then refuses to attach it ─────────────────────────────────
	// The terminal IS the agent container: pi there writes the `.jsonl` and the
	// shared `.cheasee-inuse/<id>` claim onto the workspace mount, which the ui
	// sidecar mounts too. Writing from inside the terminal — not the test host —
	// keeps the shared-mount contract real on a native daemon and on DinD (whose
	// daemon cannot see the runner's filesystem). The Go writer's exact
	// path/body is pinned untagged (TestInUseClaim_writeAndRemove /
	// TestInUseClaim_crossContainerPathPin).
	sessionID := "deadbeefcafe"
	startTerminalSession(t, containerName(root), sessionID)

	// Query the *running* ui over its real session path, not just the mount:
	// the store scan must list the mounted session as in use, and the attach
	// must be refused by the guard (the Rust reader contract is pinned untagged
	// in sessions_store.rs).
	assertUICoexistence(t, uiContainerName(root), sessionID)

	// ── AC4: `clean` then `prune-images` enumerate (and remove) the ui
	//        container and image — the operator cleanup journey ──────────────
	assertCleanupEnumeratesUI(t, ctx, root)
}

// startTerminalSession writes a terminal-shaped session file plus the live
// in-use claim onto the shared workspace mount from inside the agent
// container. These are exactly what Go's `start` writes host-side on a local
// daemon; doing it in-container keeps the mount real under DinD, where the
// daemon cannot see the runner's (host-side) workspace path.
func startTerminalSession(t *testing.T, agentName, sessionID string) {
	t.Helper()
	sessionsDir := strings.TrimSuffix(inUseClaimDir, "/.cheasee-inuse")
	body := fmt.Sprintf(`{"type":"session","id":%q,"cwd":"/workspaces/main"}`, sessionID)
	claim := fmt.Sprintf(`{"container":%q}`, agentName)
	script := fmt.Sprintf(
		"mkdir -p %s/.cheasee-inuse && printf '%%s\\n' %s > %s/%s.jsonl && printf '%%s\\n' %s > %s/.cheasee-inuse/%s",
		sessionsDir, shellQuote(body), sessionsDir, sessionID,
		shellQuote(claim), sessionsDir, sessionID,
	)
	dockerExecOK(t, agentName, "/bin/bash", "-c", script)
}

// shellQuote wraps a value in POSIX single quotes for the in-container write.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// uiSessionProbe drives the running ui server's real /ws path from inside the
// ui container: list the shared sessions, then request an attach. Node ships
// in the ui image and its global WebSocket needs no published port, so the
// probe works under DinD where only the daemon — not the published UI port —
// is reachable from the test process. The placeholder is replaced with the
// session id (a JSON string literal) by assertUICoexistence.
const uiSessionProbe = `
const id = __CHEASEE_COEXIST_SESSION__;
const ws = new WebSocket("ws://127.0.0.1:3000/ws");
const finish = (obj, code) => {
  clearTimeout(timer);
  process.exitCode = code;
  console.log(JSON.stringify(obj));
  try { ws.close(); } catch (_) {}
  // If the socket close stalls, force the recorded exit code after the flush.
  setTimeout(() => process.exit(code), 1000).unref();
};
const timer = setTimeout(() => finish({ error: "timeout waiting for the ui relay" }, 1), 15000);
ws.onerror = () => finish({ error: "websocket error" }, 1);
ws.onopen = () => ws.send(JSON.stringify({ type: "list_sessions", id: "coexist-list" }));
ws.onmessage = (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch (_) { return; }
  if (msg.type === "session_list") {
    const row = (msg.sessions || []).find((s) => s.id === id);
    if (!row) return finish({ error: "session not listed" }, 1);
    if (row.inUse !== true) return finish({ error: "session not marked in use" }, 1);
    ws.send(JSON.stringify({ type: "resume_session", id: "coexist-resume", sessionId: id, mode: "resume" }));
  } else if (msg.type === "session_action") {
    finish({ listed: true, inUse: true, refused: msg.success === false, refusal: msg.error || null }, 0);
  }
};`

// assertUICoexistence queries the running ui over its real session path: the
// mounted terminal session must be listed and marked in use, and the attach
// must be refused by the in-use guard.
func assertUICoexistence(t *testing.T, uiName, sessionID string) {
	t.Helper()
	// The session id is inlined as a JSON string literal rather than passed via
	// `docker exec -e`: `docker exec` stops parsing flags at the container name
	// (that is why `docker exec <c> bash -c ...` works), so an `-e` after the
	// container would be exec'd as the command instead of set as an env var.
	idLiteral, err := json.Marshal(sessionID)
	if err != nil {
		t.Fatalf("AC5: encode session id: %v", err)
	}
	script := strings.Replace(uiSessionProbe, "__CHEASEE_COEXIST_SESSION__", string(idLiteral), 1)
	out, execErr := dockerExecOutput(t, uiName, "node", "--no-warnings", "-e", script)
	if execErr != nil {
		t.Fatalf("AC5: ui session probe failed: %v\n%s", execErr, out)
	}
	var probe struct {
		Listed  bool   `json:"listed"`
		InUse   bool   `json:"inUse"`
		Refused bool   `json:"refused"`
		Refusal string `json:"refusal"`
	}
	if err := json.Unmarshal([]byte(out), &probe); err != nil {
		t.Fatalf("AC5: ui session probe output %q is not JSON: %v", out, err)
	}
	if !probe.Listed {
		t.Error("AC5: the running ui did not list the mounted terminal session")
	}
	if !probe.InUse {
		t.Error("AC5: the running ui did not mark the claimed session in use")
	}
	if !probe.Refused {
		t.Errorf("AC5: the running ui attached a live session instead of refusing (refusal=%q)", probe.Refusal)
	} else if !strings.Contains(strings.ToLower(probe.Refusal), "in use") {
		t.Errorf("AC5: refusal %q must name the in-use guard", probe.Refusal)
	}
}

// assertCleanupEnumeratesUI runs the real `clean` then `prune-images`
// orchestration (the operator journey) and pins AC4: clean enumerates the ui
// container by the managed label, prune-images enumerates the ui image, and
// each command removes what it reported. Destructive by design — both commands
// are host-wide; this harness is opt-in (`-tags integration`) and refuses to
// run them unless the daemon holds only this fixture's resources.
func assertCleanupEnumeratesUI(t *testing.T, ctx context.Context, root string) {
	t.Helper()
	requireDedicatedCleanupScope(t, ctx, root)

	uiName := uiContainerName(root)
	uiImage := composeProjectName(root) + "-ui"

	resetCleanState(t)
	managed, err := listManagedContainers(ctx)
	if err != nil {
		t.Fatalf("listManagedContainers: %v", err)
	}
	if !slices.Contains(managed, uiName) {
		t.Fatalf("AC4: ui container %s not enumerated by the managed label, got %v", uiName, managed)
	}

	// `clean`: the dry-run mirrors the enumeration (and names the ui container),
	// then --yes performs the removal.
	cleanDryRun = true
	dry := testutil.CaptureStderr(t, func() {
		if err := runCleanE(newCleanCmd(), nil); err != nil {
			t.Fatalf("clean --dry-run: %v", err)
		}
	})
	if !strings.Contains(dry, uiName) {
		t.Errorf("AC4: `cheasee-pi clean` did not enumerate %s:\n%s", uiName, dry)
	}
	cleanDryRun = false
	cleanYes = true
	if err := runCleanE(newCleanCmd(), nil); err != nil {
		t.Fatalf("clean --yes: %v", err)
	}
	if left, err := listManagedContainers(ctx); err != nil {
		t.Fatalf("listManagedContainers after clean: %v", err)
	} else if slices.Contains(left, uiName) {
		t.Errorf("AC4: clean --yes left %s behind: %v", uiName, left)
	}

	// `prune-images` refuses while any managed container exists, so it must run
	// after clean — the fail-closed ordering invariant.
	resetPruneState(t)
	images, err := listCheaseePiImages(ctx)
	if err != nil {
		t.Fatalf("listCheaseePiImages: %v", err)
	}
	if !slices.ContainsFunc(images, uiImageMatch(uiImage)) {
		t.Fatalf("AC4: ui image %s:* not enumerated on the host, got %v", uiImage, images)
	}
	pruneImagesDryRun = true
	pdry := testutil.CaptureStderr(t, func() {
		if err := runPruneImagesE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("prune-images --dry-run: %v", err)
		}
	})
	if !strings.Contains(pdry, uiImage+":") {
		t.Errorf("AC4: `cheasee-pi prune-images` did not enumerate %s:*:\n%s", uiImage, pdry)
	}
	pruneImagesDryRun = false
	pruneImagesYes = true
	if err := runPruneImagesE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("prune-images --yes: %v", err)
	}
	if left, err := listCheaseePiImages(ctx); err != nil {
		t.Fatalf("listCheaseePiImages after prune: %v", err)
	} else if slices.ContainsFunc(left, uiImageMatch(uiImage)) {
		t.Errorf("AC4: prune-images --yes left %s:* behind: %v", uiImage, left)
	}
}

func uiImageMatch(uiImage string) func(cheaseePiImage) bool {
	return func(img cheaseePiImage) bool { return strings.HasPrefix(img.Ref, uiImage+":") }
}

// requireDedicatedCleanupScope fails the test closed before the destructive
// `clean`/`prune-images` block. Both commands are host-wide by design (clean
// removes every managed container; prune-images removes every cheasee-pi-*
// image), so on a shared daemon they would kill unrelated active sessions and
// delete other repos' images. The harness only runs them when every managed
// container and cheasee-pi image on the daemon belongs to this fixture; a
// dedicated daemon passes, a shared one is refused loudly instead of damaged.
func requireDedicatedCleanupScope(t *testing.T, ctx context.Context, root string) {
	t.Helper()
	project := composeProjectName(root)

	mine, err := projectContainers(ctx, project)
	if err != nil {
		t.Fatalf("AC4: enumerate this fixture's containers: %v", err)
	}
	managed, err := listManagedContainers(ctx)
	if err != nil {
		t.Fatalf("AC4: enumerate managed containers: %v", err)
	}
	mineSet := make(map[string]bool, len(mine))
	for _, n := range mine {
		mineSet[n] = true
	}
	var foreign []string
	for _, n := range managed {
		if !mineSet[n] {
			foreign = append(foreign, n)
		}
	}
	if len(foreign) > 0 {
		t.Fatalf("AC4: refusing the host-wide `clean --yes` — the daemon holds managed containers outside this fixture: %v; run the integration harness against a dedicated daemon", foreign)
	}

	images, err := listCheaseePiImages(ctx)
	if err != nil {
		t.Fatalf("AC4: enumerate cheasee-pi images: %v", err)
	}
	var foreignImages []string
	for _, img := range images {
		if !strings.HasPrefix(img.Ref, project+"-") {
			foreignImages = append(foreignImages, img.Ref)
		}
	}
	if len(foreignImages) > 0 {
		t.Fatalf("AC4: refusing the host-wide `prune-images --yes` — the daemon holds cheasee-pi images outside this fixture: %v; run the integration harness against a dedicated daemon", foreignImages)
	}
}

// seedComposeHarnessWorkspace builds a real init-shaped workspace: a worktree
// at <parent>/<slug> with a sibling <parent>/.bare whose origin is the
// GitHub remote the names derive from. HOST_UID/HOST_GID are exported from the
// test user so the ui sidecar (which runs as that uid/gid) can traverse the
// host-owned config mount and pass its /health probe.
//
// The slug is unique per run: a fixed fixture name (the smoke test's
// `cli-install-smoke`) would let this harness adopt, and the destructive
// host-wide `clean`/`prune-images` block then delete, a concurrent or
// pre-existing stack that happened to share the name. A unique project name
// no other run can hold makes the teardown/cleanup scope provably this test's.
func seedComposeHarnessWorkspace(t *testing.T) string {
	t.Helper()
	t.Setenv("HOST_UID", fmt.Sprint(os.Getuid()))
	t.Setenv("HOST_GID", fmt.Sprint(os.Getgid()))

	slug := uniqueHarnessSlug(t)
	src := gitRemoteFixture(t, "main")
	parent := t.TempDir()
	root := filepath.Join(parent, slug)
	bareDir := cloneWorktreeLayout(t, src, parent, root)
	// Owner-less remote so the derived slug equals the workspace basename: the
	// project/container/image names all derive from this one unique identity.
	runGit(t, "--git-dir", bareDir, "config", "remote.origin.url",
		"https://github.com/"+slug+".git")
	testutil.WriteCheaseeSettingsFile(t, root, "{}")
	// Fail closed if the unique project somehow already holds resources: the
	// fixture may not adopt (and later tear down) a stack it did not create.
	requireProjectClean(t, root)
	return root
}

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
