package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
