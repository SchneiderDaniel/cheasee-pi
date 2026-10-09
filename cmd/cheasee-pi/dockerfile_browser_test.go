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

func constraintsPath() string {
	return filepath.Join("embedded", "docker", "scrapling-constraints.txt")
}

func readConstraints(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(constraintsPath())
	if err != nil {
		t.Fatalf("read scrapling constraints: %v", err)
	}
	return string(data)
}

func TestDockerfile_PipUsesScraplingConstraints(t *testing.T) {
	content := readDockerfile(t)
	copyLine := "COPY scrapling-constraints.txt /opt/venvs/scrapling-constraints.txt"
	installLine := "-c /opt/venvs/scrapling-constraints.txt"
	copyIdx := strings.Index(content, copyLine)
	if copyIdx == -1 {
		t.Fatalf("Dockerfile must COPY the constraints file into the build context result (%q)", copyLine)
	}
	installIdx := strings.Index(content, installLine)
	if installIdx == -1 {
		t.Fatalf("Layer 5e pip install must run with %q", installLine)
	}
	if copyIdx > installIdx {
		t.Error("the constraints COPY must precede the pip install that reads it")
	}
	// The scrapling requirement keeps its extras (constraints cannot carry them).
	if !strings.Contains(content, "scrapling[fetchers]") {
		t.Error("pip install must still request scrapling[fetchers] alongside the constraints ceiling")
	}
	// Runtime venv re-creation in the container must be pinned too (the venv
	// adapter appends -c when SCRAPLING_PIP_CONSTRAINTS points at a real file).
	if !strings.Contains(content, "ENV SCRAPLING_PIP_CONSTRAINTS=/opt/venvs/scrapling-constraints.txt") {
		t.Error("image must export SCRAPLING_PIP_CONSTRAINTS so a runtime pip install stays pinned")
	}
}

func TestScraplingConstraints_PinsStack(t *testing.T) {
	content := readConstraints(t)
	// Every package the venv installs must be pinned to an exact version: a
	// floating patchright is what let the baked browser and the runtime disagree
	// on the chromium revision.
	for _, pin := range []string{
		"scrapling==0.4.15",
		"patchright==1.62.2",
		"playwright==1.62.0",
		"markdownify==1.2.3",
		"beautifulsoup4==4.15.0",
	} {
		if !strings.Contains(content, pin) {
			t.Errorf("constraints must pin %q", pin)
		}
	}
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !strings.Contains(line, "==") {
			t.Errorf("constraint line %q must be an exact pin", line)
		}
		if strings.Contains(line, "[") {
			t.Errorf("constraint line %q must not carry extras (pip: 'Constraints cannot have extras')", line)
		}
	}
}

func TestTestsWorkflow_ScraplingUsesConstraints(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", ".github", "workflows", "tests.yml"))
	if err != nil {
		t.Fatalf("read tests workflow: %v", err)
	}
	workflow := string(data)
	// CI must provision the venv from the same pins as the image, otherwise the
	// e2e tier bakes a chromium revision the image would never ship.
	if !strings.Contains(workflow, "-c cmd/cheasee-pi/embedded/docker/scrapling-constraints.txt") {
		t.Error("scrapling-e2e must install with -c cmd/cheasee-pi/embedded/docker/scrapling-constraints.txt")
	}
	if !strings.Contains(workflow, "scrapling-constraints.txt") {
		t.Error("scrapling-e2e cache key must include the constraints file")
	}
}

// ──────────────────────────────────────────────
// Phase 9c: docker build surface simplification (#1609)
// ──────────────────────────────────────────────

func TestDockerfile_ArchMappingsDirect(t *testing.T) {
	content := readDockerfile(t)
	// The three arch-case blocks must be replaced by direct stdlib-queried
	// asset names. The query asymmetry is load-bearing: rust-analyzer's assets
	// use uname -m names (x86_64/aarch64), osv-scanner and Go use dpkg names
	// (amd64/arm64); both report the emulated arch under buildx qemu.
	for _, want := range []string{
		"rust-analyzer-$(uname -m)-unknown-linux-gnu.gz",
		"osv-scanner_linux_$(dpkg --print-architecture)",
		"go${GO_VERSION}.linux-$(dpkg --print-architecture).tar.gz",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("direct arch mapping %q must replace the case block", want)
		}
	}
	if strings.Contains(content, "Unsupported arch") {
		t.Error("unsupported-arch guards must be gone (other arches 404 via curl -fsSL exit 22)")
	}
}

func TestDockerfile_OsvRetryLoopReplaced(t *testing.T) {
	content := readDockerfile(t)
	// osv-scanner's shell retry loop is replaced by curl's own retry:
	// --retry-all-errors covers the mid-flight "Connection died" (curl 56)
	// case the loop existed for (plain --retry skips it), and --retry-delay 2
	// keeps persistent-failure latency ≈ parity with the 3×5s sleeps.
	if !strings.Contains(content, `curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 "https://github.com/google/osv-scanner`) {
		t.Error("osv-scanner download must use curl -fsSL --retry 5 --retry-all-errors --retry-delay 2")
	}
	// rtk (5c) and patchright (5e) loops must stay — they wrap non-curl
	// commands (and curl | sh output is not reset on retry).
	if got := strings.Count(content, "for i in 1 2 3"); got != 2 {
		t.Errorf("exactly the rtk + patchright retry loops may remain, got %d 'for i in 1 2 3'", got)
	}
}

func TestDockerfile_LocaleSingleEnv(t *testing.T) {
	content := readDockerfile(t)
	// Three locale ENVs collapse into one instruction (same values, one layer
	// boundary); the other ENVs stay untouched.
	if !strings.Contains(content, "ENV LANG=C.UTF-8 LC_CTYPE=C.UTF-8 LC_ALL=C.UTF-8") {
		t.Error("the three locale ENV lines must collapse into one ENV line")
	}
	if strings.Contains(content, "ENV LC_CTYPE=C.UTF-8\n") || strings.Contains(content, "ENV LC_ALL=C.UTF-8\n") {
		t.Error("no standalone per-key locale ENV lines may remain")
	}
	if !strings.Contains(content, "ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers") {
		t.Error("PLAYWRIGHT_BROWSERS_PATH ENV must be retained")
	}
	if !strings.Contains(content, "ENV PATH=") {
		t.Error("PATH ENV must be retained")
	}
}

func TestDockerfile_FontcacheFdfindChained(t *testing.T) {
	content := readDockerfile(t)
	// fc-cache + the fdfind symlink fold into the Layer 3 apt RUN via &&
	// (two fewer layers); standalone RUN layers must be gone.
	if !strings.Contains(content, "&& fc-cache -f \\") {
		t.Error("fc-cache must be chained into the apt RUN with && fc-cache -f")
	}
	if !strings.Contains(content, "&& ln -sf /usr/bin/fdfind /usr/local/bin/fd \\") {
		t.Error("fdfind symlink must be chained into the apt RUN")
	}
	if strings.Contains(content, "RUN fc-cache") || strings.Contains(content, "RUN ln -sf") {
		t.Error("no standalone RUN fc-cache / RUN ln -sf layer may remain")
	}
}

func TestDockerfile_NoWget(t *testing.T) {
	content := readDockerfile(t)
	if strings.Contains(content, "wget") {
		t.Error("wget must be removed from the image (curl already installed in Layer 1; no in-image consumer)")
	}
	// Docs mirror the image dependency inventory — stale wget listings would
	// mislead SBOM/architecture readers.
	for _, rel := range []string{
		filepath.Join("..", "..", "docs", "sbom.md"),
		filepath.Join("..", "..", "docs", "architecture.md"),
	} {
		data, err := os.ReadFile(rel)
		if err != nil {
			t.Fatalf("read %s: %v", rel, err)
		}
		if strings.Contains(string(data), "wget") {
			t.Errorf("%s must no longer list wget as an image dependency", rel)
		}
	}
}
