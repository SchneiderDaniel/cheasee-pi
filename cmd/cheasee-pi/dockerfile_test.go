package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// dockerfilePath is the embedded Dockerfile (canonical source, go:embed-backed).
func dockerfilePath() string {
	return filepath.Join("embedded", "docker", "Dockerfile")
}

// composePath is the embedded docker-compose.yml.
func composePath() string {
	return filepath.Join("embedded", "docker", "docker-compose.yml")
}

func readDockerfile(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(dockerfilePath())
	if err != nil {
		t.Fatalf("read embedded Dockerfile: %v", err)
	}
	return string(data)
}

func readCompose(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(composePath())
	if err != nil {
		t.Fatalf("read embedded docker-compose.yml: %v", err)
	}
	return string(data)
}

// ──────────────────────────────────────────────
// Phase 7: Dockerfile resource invariants
// ──────────────────────────────────────────────

func TestDockerfile_ClonesCheaseePi(t *testing.T) {
	content := readDockerfile(t)
	if !strings.Contains(content, "git clone --depth 1 --branch ${CHEASEE_REF} https://github.com/SchneiderDaniel/cheasee-pi /opt/cheasee-pi") {
		t.Error("Dockerfile must clone the cheasee-pi repo to /opt/cheasee-pi (ARG CHEASEE_REF)")
	}
	if !strings.Contains(content, "ARG CHEASEE_REF=main") {
		t.Error("Dockerfile must default ARG CHEASEE_REF to main")
	}
	if strings.Contains(content, "COPY pi-resources/") {
		t.Error("Dockerfile must not COPY a staged pi-resources tree (repo is cloned instead)")
	}
	if !strings.Contains(content, "/opt/cheasee-pi/.pi/extensions/ponytail") {
		t.Error("Dockerfile must remove the ponytail extension (loads from gitignored .pi/git)")
	}
}

func TestDockerfile_SymlinkLayerUsesExplicitHome(t *testing.T) {
	content := readDockerfile(t)
	// The symlink layer must target /home/agentuser/.pi/agent/... explicitly —
	// `~` after a USER switch resolves to /root (Docker does not set $HOME).
	if !strings.Contains(content, "/home/agentuser/.pi/agent/") {
		t.Error("symlink layer must use explicit /home/agentuser/.pi/agent paths")
	}
	if strings.Contains(content, "ln -s ~") {
		t.Error("symlink layer must not use ~ (USER-switch HOME pitfall)")
	}
}

func TestDockerfile_SymlinkLayerCoversResources(t *testing.T) {
	content := readDockerfile(t)
	for _, want := range []string{
		".pi/skills",     // skills + .pi/skills resource dir
		".pi/prompts",    // prompts
		".pi/extensions", // extensions (caveman/supervisor/…) load globally
		"themes",         // themes
		"custom",         // custom/* (guarded — gitignored, absent on fresh clones)
		"check-extensions",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("symlink layer should reference %q", want)
		}
	}
}

func TestDockerfile_AppendSystemPromptSymlink(t *testing.T) {
	content := readDockerfile(t)
	// Layer 6b must create the global append symlink — explicit
	// /home/agentuser path (USER-switch HOME pitfall) and guarded by
	// [ -f ] so old CHEASEE_REF tags without the repo-root file leave no
	// dangling link.
	if !strings.Contains(content, "ln -sfn /opt/cheasee-pi/APPEND_SYSTEM.md /home/agentuser/.pi/agent/APPEND_SYSTEM.md") {
		t.Error("Layer 6b must symlink /opt/cheasee-pi/APPEND_SYSTEM.md into /home/agentuser/.pi/agent/APPEND_SYSTEM.md")
	}
	if !strings.Contains(content, "[ -f /opt/cheasee-pi/APPEND_SYSTEM.md ]") {
		t.Error("APPEND_SYSTEM.md symlink must be guarded by [ -f /opt/cheasee-pi/APPEND_SYSTEM.md ] (no dangling links on old CHEASEE_REF tags)")
	}
}

func TestDockerfile_PiLayerAfterCloneBeforeEntrypoint(t *testing.T) {
	content := readDockerfile(t)
	// Issue #1603: the pi-coding-agent install is the one layer busted on
	// every build (PI_BUILD_STAMP cache-busting contract), so it must sit
	// AFTER the expensive clone/npm-ci/symlink layers (6b) and BEFORE the
	// entrypoint COPY (7) — otherwise a pi bump re-runs the whole clone +
	// npm ci. The byte-offset chain pins the order: clone < npm ci < symlink
	// wiring < pi install < entrypoint COPY.
	markers := []struct {
		name string
		text string
	}{
		{"clone (6b)", "git clone --depth 1 --branch ${CHEASEE_REF} https://github.com/SchneiderDaniel/cheasee-pi /opt/cheasee-pi"},
		{"npm ci (6b)", "npm ci --no-audit --no-fund"},
		{"symlink wiring (6b)", "chown -R agentuser:agentuser /home/agentuser/.pi"},
		{"pi install (6c)", "npm install -g --force @earendil-works/pi-coding-agent"},
		{"entrypoint COPY (7)", "COPY entrypoint.sh /usr/local/bin/entrypoint.sh"},
	}
	idxs := make([]int, len(markers))
	for i, m := range markers {
		idx := strings.Index(content, m.text)
		if idx == -1 {
			t.Fatalf("Dockerfile must contain %s marker %q (missing anchor — a reorder could silently pass)", m.name, m.text)
		}
		idxs[i] = idx
	}
	for i := 1; i < len(idxs); i++ {
		if idxs[i-1] > idxs[i] {
			t.Errorf("layer order broken: %s (offset %d) must precede %s (offset %d); the pi layer must sit after the 6b clone/npm-ci/symlink layers and before Layer 7's COPY", markers[i-1].name, idxs[i-1], markers[i].name, idxs[i])
		}
	}
	// Renumered 5h -> 6c: the new header must be present and the old one gone
	// (grep confirms "5h" appears nowhere else in the repo — renumber is safe).
	if !strings.Contains(content, "Layer 6c: pi-coding-agent") {
		t.Error("moved pi layer must be renumbered 'Layer 6c: pi-coding-agent'")
	}
	if strings.Contains(content, "Layer 5h") {
		t.Error("old 'Layer 5h' header must be gone (pi layer renumbered to 6c)")
	}
	// Stamp contract stays inside the moved RUN (AC4): exactly one ARG and one
	// echo, with the echo strictly between the install line and the Layer 7
	// header — it cannot drift out of the RUN block.
	if got := strings.Count(content, "ARG PI_BUILD_STAMP"); got != 1 {
		t.Errorf("exactly one 'ARG PI_BUILD_STAMP' required (cache-busting contract), got %d", got)
	}
	echoLine := `echo "${PI_BUILD_STAMP}" >/var/lib/pi-build-stamp`
	if got := strings.Count(content, echoLine); got != 1 {
		t.Errorf("exactly one stamp echo (%q) required, got %d", echoLine, got)
	}
	installIdx := strings.Index(content, "npm install -g --force @earendil-works/pi-coding-agent")
	layer7Idx := strings.Index(content, "# Layer 7:")
	if installIdx == -1 || layer7Idx == -1 {
		t.Fatal("pi install line or Layer 7 header missing")
	}
	echoIdx := strings.Index(content, echoLine)
	if !(installIdx < echoIdx && echoIdx < layer7Idx) {
		t.Errorf("stamp echo (offset %d) must sit inside the pi RUN: after the install line (offset %d) and before the Layer 7 header (offset %d)", echoIdx, installIdx, layer7Idx)
	}
	// No duplicate install, and the npm cache clean stays within the moved block.
	if got := strings.Count(content, "npm install -g --force @earendil-works/pi-coding-agent"); got != 1 {
		t.Errorf("exactly one pi install line required, got %d", got)
	}
	if block := content[installIdx:layer7Idx]; !strings.Contains(block, "npm cache clean --force") {
		t.Error("moved pi RUN must retain 'npm cache clean --force'")
	}
}

func TestDockerfile_PrivatePiSymlinkGuarded(t *testing.T) {
	content := readDockerfile(t)
	if !strings.Contains(content, "if [ -d /opt/cheasee-pi/private-pi ]") {
		t.Error("private-pi symlink must be guarded by 'if [ -d /opt/cheasee-pi/private-pi ]'")
	}
}

func TestDockerfile_WorkspacePathsStillMain(t *testing.T) {
	content := readDockerfile(t)
	// venv pre-install and entrypoint still target /workspaces/main (the fixed
	// mount point) — the repo is mounted there, not /workspaces.
	for _, want := range []string{"/workspaces/main", "worktree-fix.sh", "entrypoint.sh"} {
		if !strings.Contains(content, want) {
			t.Errorf("Dockerfile should still reference %q", want)
		}
	}
}

func TestDockerfile_Layer6bDeviationDocumented(t *testing.T) {
	// The baked /opt/cheasee-pi copy is product data (CHEASEE_REF-pinned,
	// re_point marker contract) — deliberately NOT a pi package. The
	// deviation must be documented: no pi git-folder layout, no second npm
	// install at build.
	content := readDockerfile(t)
	for _, want := range []string{
		"INTENTIONAL DEVIATION",
		"CHEASEE_REF",
		"NOT a pi package",
		"npm install",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("Layer 6b comment must document the intentional deviation (%q)", want)
		}
	}
}

// ──────────────────────────────────────────────
// Phase 9: Layer 5e browser provisioning invariants
// ──────────────────────────────────────────────

func TestDockerfile_BrowserProvisionedByPatchright(t *testing.T) {
	content := readDockerfile(t)
	// Layer 5e must install chromium via the runtime stealth fetcher's own tool
	// (patchright), so the installed build matches the revision the fetcher
	// resolves from its registry — never playwright's divergent revision set.
	if !strings.Contains(content, "/opt/venvs/scrapling-venv/bin/python -m patchright install chromium") {
		t.Error("Layer 5e must run 'python -m patchright install chromium' against the scrapling venv")
	}
}

func TestDockerfile_NoPlaywrightInstall(t *testing.T) {
	// Regression guard for Root cause 1: playwright's chromium revision (1234 at
	// 1.62.0) never matches what the patchright-driven stealth tier looks up
	// (1228 at patchright 1.61.2), so a fully successful 'playwright install
	// chromium' still ships a broken layer. The word may appear in comments; the
	// install invocation may not.
	content := readDockerfile(t)
	if strings.Contains(content, "playwright install") {
		t.Error("Dockerfile must never run 'playwright install' — use 'python -m patchright install chromium'")
	}
}

func TestDockerfile_BrowserInstallGuardPrecedesChmod(t *testing.T) {
	content := readDockerfile(t)
	// Root cause 2: after three failed download attempts the retry loop's last
	// executed command is `sleep 5` (exit 0), so without a guard the && chain
	// proceeds and the layer reports success with an empty browser cache. The
	// guard must run before chmod (mirrors Layer 5c's `test -x` guard).
	guard := `test -n "$(find /opt/playwright-browsers -maxdepth 3 -type f -path '*/chrome-linux64/chrome' -print -quit)"`
	guardIdx := strings.Index(content, guard)
	if guardIdx == -1 {
		t.Fatal("Layer 5e must guard the browser install after the retry loop (total download failure must fail the build)")
	}
	chmodIdx := strings.Index(content, "chmod -R a+rX /opt/playwright-browsers")
	if chmodIdx == -1 {
		t.Fatal("Layer 5e must chmod the browser cache world-readable")
	}
	if guardIdx > chmodIdx {
		t.Error("the browser-existence guard must run before chmod (guard failure must fail the build)")
	}
}

func TestDockerfile_PlaywrightBrowsersPathEnvRetained(t *testing.T) {
	content := readDockerfile(t)
	// Registry-path contract with runtime: entrypoint.sh symlinks
	// ~/.cache/ms-playwright → /opt/playwright-browsers, and the verify command
	// resolves PLAYWRIGHT_BROWSERS_PATH first.
	if !strings.Contains(content, "ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers") {
		t.Error("Layer 5e must keep ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers")
	}
}

func TestDockerfile_BrowserLayerSizeCommentUpdated(t *testing.T) {
	content := readDockerfile(t)
	// Browser footprint is ~646M/arch (chromium 379M + headless shell 262M +
	// ffmpeg 4.9M), not the old ~175 MB.
	if !strings.Contains(content, "646") {
		t.Error("Layer 5e comment should state the ~646M/arch browser footprint (was ~175 MB)")
	}
}

// ──────────────────────────────────────────────
// Phase 9b: Layer 5e browser guard — behavioral check
// ──────────────────────────────────────────────

// browserGuardFindCmd is the exact find expression the Dockerfile guard runs.
const browserGuardFindCmd = `find /opt/playwright-browsers -maxdepth 3 -type f -path '*/chrome-linux64/chrome' -print -quit`

// runBrowserGuard evaluates `test -n "$(find …)"` (the Dockerfile's extracted
// guard expression) against cacheRoot in a real bash and reports whether the
// guard passes (exit 0).
func runBrowserGuard(t *testing.T, cacheRoot string) bool {
	t.Helper()
	content := readDockerfile(t)
	if !strings.Contains(content, browserGuardFindCmd) {
		t.Fatal("Dockerfile must contain the browser guard find command")
	}
	guard := strings.ReplaceAll(browserGuardFindCmd, "/opt/playwright-browsers", `"`+cacheRoot+`"`)
	script := `test -n "$(` + guard + `)"; echo $?`
	out, err := exec.Command("bash", "-c", script).CombinedOutput()
	if err != nil {
		t.Fatalf("bash guard run failed: %v (%s)", err, out)
	}
	return strings.TrimSpace(string(out)) == "0"
}

func TestDockerfile_BrowserGuardBehavior(t *testing.T) {
	// Behavioral check of the extracted guard expression in real bash:
	//   empty dir → fail
	//   only .links/ marker → fail (observed broken image state)
	//   chromium-<rev>/chrome-linux64/chrome present → pass
	//   two chromium-* dirs with one complete → pass (partial-retry safe)
	cases := []struct {
		name  string
		setup func(t *testing.T, root string)
		want  bool
	}{
		{
			name: "empty cache fails",
			setup: func(t *testing.T, root string) {
				t.Helper()
			},
			want: false,
		},
		{
			name: "only .links marker fails (observed broken image)",
			setup: func(t *testing.T, root string) {
				t.Helper()
				if err := os.MkdirAll(filepath.Join(root, ".links"), 0o755); err != nil {
					t.Fatal(err)
				}
			},
			want: false,
		},
		{
			name: "chromium build present passes",
			setup: func(t *testing.T, root string) {
				t.Helper()
				writeFakeChrome(t, root, "chromium-1228")
			},
			want: true,
		},
		{
			name: "two chromium dirs, one complete, passes (partial-retry safe)",
			setup: func(t *testing.T, root string) {
				t.Helper()
				// Incomplete leftover from a prior retry attempt.
				if err := os.MkdirAll(filepath.Join(root, "chromium-1234", "chrome-linux64"), 0o755); err != nil {
					t.Fatal(err)
				}
				writeFakeChrome(t, root, "chromium-1228")
			},
			want: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			tc.setup(t, root)
			if got := runBrowserGuard(t, root); got != tc.want {
				t.Errorf("guard result = %v, want %v", got, tc.want)
			}
		})
	}
}

// writeFakeChrome writes a regular file at <root>/<buildDir>/chrome-linux64/chrome
// (the layout patchright installs, e.g. chromium-1228/chrome-linux64/chrome).
func writeFakeChrome(t *testing.T, root, buildDir string) {
	t.Helper()
	binary := filepath.Join(root, buildDir, "chrome-linux64", "chrome")
	if err := os.MkdirAll(filepath.Dir(binary), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("chrome"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// ──────────────────────────────────────────────
// Phase 8: compose invariants + YAML validity
// ──────────────────────────────────────────────

func TestCompose_ValidYAMLAndProjectName(t *testing.T) {
	content := readCompose(t)
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(content), &doc); err != nil {
		t.Fatalf("docker-compose.yml must parse as valid YAML: %v", err)
	}
	// name: cheasee-pi is the fallback for direct compose usage (the CLI
	// always injects a per-repo COMPOSE_PROJECT_NAME; the cache-dir basename
	// — the version key, e.g. "0.50" — would fail compose ≥v2.17 charset
	// validation without it).
	if doc["name"] != "cheasee-pi" {
		t.Errorf("top-level name must be 'cheasee-pi' (fallback for direct usage), got %v", doc["name"])
	}
	// Both services carry the managed label — clean enumerates by it.
	services, ok := doc["services"].(map[string]any)
	if !ok {
		t.Fatalf("services section missing: %v", doc)
	}
	for _, svcName := range []string{"cheasee-pi", "codeflow"} {
		svc, ok := services[svcName].(map[string]any)
		if !ok {
			t.Fatalf("service %q missing", svcName)
		}
		labels, ok := svc["labels"].([]any)
		if !ok || !slices.Contains(labels, managedLabel) {
			t.Errorf("service %s must carry the managed label %q, got %v", svcName, managedLabel, labels)
		}
		if len(labels) != 1 {
			t.Errorf("service %s must carry no other labels, got %v", svcName, labels)
		}
	}
}

func TestCompose_WorkspaceVolumeAbsolute(t *testing.T) {
	content := readCompose(t)
	if !strings.Contains(content, "${WORKSPACE_HOST_PATH}:/workspaces/main") {
		t.Error("cheasee-pi volume must bind ${WORKSPACE_HOST_PATH} at /workspaces/main")
	}
	if strings.Contains(content, "../../:/workspaces") {
		t.Error("relative repo-root volume must be gone (compose lives in the cache dir)")
	}
}

func TestCompose_ConfigMountsRetained(t *testing.T) {
	content := readCompose(t)
	for _, want := range []string{
		"~/.config/gh:/home/agentuser/.config/gh",
		"~/.config/cheasee-pi:/home/agentuser/.config/cheasee-pi",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("compose should retain bind-mount %q", want)
		}
	}
}

func TestCompose_BuildContextIsCacheDir(t *testing.T) {
	content := readCompose(t)
	if !strings.Contains(content, "context: .") {
		t.Error("build context must be . (the cache dir)")
	}
	if !strings.Contains(content, "dockerfile: Dockerfile") {
		t.Error("compose must reference the Dockerfile at the context root")
	}
}

func TestCompose_CodeflowPointsAtWorkspace(t *testing.T) {
	content := readCompose(t)
	for _, want := range []string{
		"REPO_ROOT=/workspaces/main",
		"${WORKSPACE_HOST_PATH}:/workspaces/main:ro",
		"./codeflow/config.json:/opt/codeflow/config.json:ro",
		"context: codeflow",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("codeflow service should contain %q", want)
		}
	}
}

func TestCompose_DefaultsPresent(t *testing.T) {
	content := readCompose(t)
	for _, want := range []string{
		"${CHEASEEPI_MEMORY:-5G}",
		"${CHEASEEPI_CPUS:-4.0}",
		"${CODEFLOW_PORT:-8470}",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("compose should keep default %q", want)
		}
	}
}

func TestCompose_BareSiblingMount(t *testing.T) {
	content := readCompose(t)
	// The sibling bare repo is bind-mounted at /workspaces/.bare so
	// worktree-fix.sh sees its expected layout; the workspace folder mount is
	// retained. :Z relabel (VOLUME_RELABEL) applies to both.
	if !strings.Contains(content, "${WORKSPACE_BARE_PATH}:/workspaces/.bare${VOLUME_RELABEL:-}") {
		t.Error("compose must bind ${WORKSPACE_BARE_PATH} at /workspaces/.bare with the relabel suffix")
	}
	if !strings.Contains(content, "${WORKSPACE_HOST_PATH}:/workspaces/main${VOLUME_RELABEL:-}") {
		t.Error("compose must keep the ${WORKSPACE_HOST_PATH}:/workspaces/main mount with the relabel suffix")
	}
	// The mount must be a sibling, never a parent-of-folder single mount.
	if strings.Contains(content, "${WORKSPACE_HOST_PATH}/../:/workspaces") {
		t.Error("compose must not mount the whole parent at /workspaces")
	}
}
