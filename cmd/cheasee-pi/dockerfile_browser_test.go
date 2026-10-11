package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

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
	guardIdx := strings.Index(content, browserGuardExpr)
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

func TestDockerfile_BrowserGuardRevisionSpecific(t *testing.T) {
	content := readDockerfile(t)
	// The guard must assert the revision *patchright* resolves, read from the
	// venv's own browsers.json — not "some chromium build exists". The #1986
	// image shipped chromium-1243 while patchright looked for 1234 and the old
	// any-chrome find guard happily passed.
	if !strings.Contains(content, browserRevisionLookup) {
		t.Error("Layer 5e must read the expected revision from the venv's patchright browsers.json")
	}
	if !strings.Contains(content, "rev=\"$("+browserRevisionLookup+")\"") {
		t.Error("the guard's revision must come from the browsers.json lookup, not a hardcoded number")
	}
	if !strings.Contains(content, browserGuardExpr) {
		t.Errorf("Layer 5e must assert %q", browserGuardExpr)
	}
	if strings.Contains(content, anyChromeFindGuard) {
		t.Error("the any-chrome find guard must be gone — it passes on a mismatched revision")
	}
	// The stale revision contract in the comment (patchright 1.61.2 / chromium
	// 1228) described a stack nobody installs any more; the pins live in
	// scrapling-constraints.txt.
	for _, stale := range []string{"1.61.2", "chromium revision 1228"} {
		if strings.Contains(content, stale) {
			t.Errorf("layer 5e comment must not state the stale browser contract (%q)", stale)
		}
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

// browserRevisionLookup is the exact python one-liner the Dockerfile runs to
// learn which chromium revision the pinned patchright resolves.
const browserRevisionLookup = `/opt/venvs/scrapling-venv/bin/python -c "import json, pathlib, patchright; print(next(b['revision'] for b in json.loads((pathlib.Path(patchright.__file__).parent / 'driver/package/browsers.json').read_text())['browsers'] if b['name'] == 'chromium'))"`

// browserGuardExpr is the exact guard the Dockerfile applies to that revision.
const browserGuardExpr = `test -f "/opt/playwright-browsers/chromium-$rev/chrome-linux64/chrome"`

// anyChromeFindGuard is the pre-#1986 guard: it passed for ANY chromium build,
// including one whose revision patchright never resolves.
const anyChromeFindGuard = `test -n "$(find /opt/playwright-browsers -maxdepth 3 -type f -path '*/chrome-linux64/chrome' -print -quit)"`

// runBrowserGuard evaluates the Dockerfile's extracted guard expression in a real
// bash against cacheRoot, with the expected revision set to rev.
func runBrowserGuard(t *testing.T, cacheRoot, rev string) bool {
	t.Helper()
	content := readDockerfile(t)
	if !strings.Contains(content, browserGuardExpr) {
		t.Fatal("Dockerfile must contain the browser guard expression")
	}
	// via $root: t.TempDir() paths can contain shell metacharacters ("(").
	guard := strings.ReplaceAll(browserGuardExpr, "/opt/playwright-browsers", "$root")
	script := "rev='" + rev + "'; root='" + cacheRoot + "'; " + guard + "; echo $?"
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
	//   chromium-1243 present but expected 1234 → fail (the #1986 mismatch)
	//   expected chromium-<rev> present → pass
	//   both revisions present → pass (a stale extra build is harmless)
	cases := []struct {
		name  string
		rev   string
		setup func(t *testing.T, root string)
		want  bool
	}{
		{
			name: "empty cache fails",
			rev:  "1234",
			setup: func(t *testing.T, root string) {
				t.Helper()
			},
			want: false,
		},
		{
			name: "only .links marker fails (observed broken image)",
			rev:  "1234",
			setup: func(t *testing.T, root string) {
				t.Helper()
				if err := os.MkdirAll(filepath.Join(root, ".links"), 0o755); err != nil {
					t.Fatal(err)
				}
			},
			want: false,
		},
		{
			name: "different revision present fails (chromium-1243 vs expected 1234)",
			rev:  "1234",
			setup: func(t *testing.T, root string) {
				t.Helper()
				writeFakeChrome(t, root, "chromium-1243")
			},
			want: false,
		},
		{
			name: "expected revision present passes",
			rev:  "1234",
			setup: func(t *testing.T, root string) {
				t.Helper()
				writeFakeChrome(t, root, "chromium-1234")
			},
			want: true,
		},
		{
			name: "stale extra revision alongside the expected one passes",
			rev:  "1234",
			setup: func(t *testing.T, root string) {
				t.Helper()
				writeFakeChrome(t, root, "chromium-1243")
				writeFakeChrome(t, root, "chromium-1234")
			},
			want: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			tc.setup(t, root)
			if got := runBrowserGuard(t, root, tc.rev); got != tc.want {
				t.Errorf("guard result = %v, want %v", got, tc.want)
			}
		})
	}
}

// writeFakeChrome writes a regular file at <root>/<buildDir>/chrome-linux64/chrome
// (the layout patchright installs, e.g. chromium-1234/chrome-linux64/chrome).
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
// Phase 9d: pinned Python stack (#1986)
// ──────────────────────────────────────────────
