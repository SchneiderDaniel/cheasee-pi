package main

import (
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
