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
