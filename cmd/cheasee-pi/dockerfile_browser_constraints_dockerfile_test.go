package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
	// (two fewer layers); standalone RUN layers must be gone. No trailing `\`
	// required: the apt cleanups that used to follow are gone with the cache
	// mounts (issue #2053), so the symlink may be the last chained command.
	if !strings.Contains(content, "&& fc-cache -f") {
		t.Error("fc-cache must be chained into the apt RUN with && fc-cache -f")
	}
	if !strings.Contains(content, "&& ln -sf /usr/bin/fdfind /usr/local/bin/fd") {
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
