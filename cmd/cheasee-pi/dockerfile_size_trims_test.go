package main

import (
	"os/exec"
	"strings"
	"testing"
)

// Image-size trims: each removes payload no runtime path reads. These are
// Dockerfile string contracts, not runtime code, so a refactor could silently
// re-add the weight — guard them here.

func TestDockerfile_SizeTrimsPresent(t *testing.T) {
	content := readDockerfile(t)
	for _, want := range []string{
		"rm -rf /usr/include/node",
		"/opt/venvs/scrapling-venv/lib/python*/site-packages/playwright/driver",
		"/usr/lib/node_modules/@ast-grep/cli/node_modules",
		"/usr/lib/node_modules/jscpd/node_modules/jscpd-linux-*",
		"rm -rf /usr/local/go/test /usr/local/go/api /usr/local/go/doc /usr/local/go/misc",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("docker/Dockerfile must keep size trim %q", want)
		}
	}
}

// A trim must sit after the install that creates its payload: `rm -rf` on a
// not-yet-existing path succeeds silently, so a reorder would turn the trim
// into a no-op without failing the build.

func TestDockerfile_SizeTrimOrdering(t *testing.T) {
	content := readDockerfile(t)
	pairs := []struct {
		name, trim, anchor string
	}{
		{"node headers", "rm -rf /usr/include/node", "test -x /usr/bin/npm"},
		{"ast-grep duplicate", "/usr/lib/node_modules/@ast-grep/cli/node_modules", "typescript-language-server \\"},
		{"jscpd optional", "/usr/lib/node_modules/jscpd/node_modules/jscpd-linux-*", "typescript-language-server \\"},
		{"playwright driver", "/site-packages/playwright/driver", "beautifulsoup4 \\"},
		{"go trees", "/usr/local/go/test /usr/local/go/api", "/usr/local/go/bin/go version"},
	}
	for _, p := range pairs {
		trimIdx := strings.Index(content, p.trim)
		anchorIdx := strings.Index(content, p.anchor)
		if trimIdx == -1 {
			t.Errorf("%s: trim %q missing", p.name, p.trim)
			continue
		}
		if anchorIdx == -1 {
			t.Errorf("%s: anchor %q missing", p.name, p.anchor)
			continue
		}
		if anchorIdx > trimIdx {
			t.Errorf("%s: trim (offset %d) must follow install anchor %q (offset %d)", p.name, trimIdx, p.anchor, anchorIdx)
		}
	}
}

// The trims must not reach into payload the runtime reads. These are the
// neighbours a fat-fingered path or a widened glob would clip.

func TestDockerfile_SizeTrimsDoNotOverreach(t *testing.T) {
	content := readDockerfile(t)
	for _, forbidden := range []string{
		"rm -rf /opt/playwright-browsers",                                       // chromium (scrapling forces channel: "chromium")
		"rm -rf /opt/venvs/scrapling-venv/lib/python*/site-packages/patchright", // stealth driver
		"rm -rf /usr/lib/node_modules/npm",                                      // entrypoint runs npm install
		"rm -rf /usr/lib/node_modules/@ast-grep/cli/ast-grep",                   // the /usr/bin target itself
		"rm -rf /usr/local/go/pkg",                                              // compiler + toolchain
		"rm -rf /usr/local/go/src",                                              // stdlib source
	} {
		if strings.Contains(content, forbidden) {
			t.Errorf("docker/Dockerfile must not remove %q", forbidden)
		}
	}
	if !strings.Contains(content, "chmod -R a+rX /opt/playwright-browsers") {
		t.Error("docker/Dockerfile must keep the chromium cache world-readable")
	}
}

// The jscpd optional prebuilt is published per-arch (jscpd-linux-x64-gnu,
// jscpd-linux-arm64-gnu). A hardcoded x64 path would leave ~45M on arm64.

func TestDockerfile_JscpdTrimArchIndependent(t *testing.T) {
	content := readDockerfile(t)
	if !strings.Contains(content, "jscpd-linux-*") {
		t.Error("docker/Dockerfile jscpd trim must use the arch-independent jscpd-linux-* glob")
	}
	if strings.Contains(content, "jscpd-linux-x64") {
		t.Error("docker/Dockerfile jscpd trim must not hardcode amd64")
	}
}

func TestUIDockerfile_SizeTrimsPresent(t *testing.T) {
	df := uiAsset(t, "Dockerfile")
	if !strings.Contains(df, "rm -rf /usr/include/node") {
		t.Error("ui/Dockerfile must remove /usr/include/node (no native compile in the runtime sidecar)")
	}
}

func TestUIDockerfile_SizeTrimsDoNotOverreach(t *testing.T) {
	df := uiAsset(t, "Dockerfile")
	for _, forbidden := range []string{
		"rm -rf /usr/lib/node_modules/npm", // the spawned `pi` child installs packages with it
		"rm -rf /usr/bin/node",             // pi is a node script
		"rm -rf /usr/lib/node_modules/@earendil-works",
	} {
		if strings.Contains(df, forbidden) {
			t.Errorf("ui/Dockerfile must not remove %q", forbidden)
		}
	}
	if !strings.Contains(df, "test -x /usr/bin/npm") {
		t.Error("ui/Dockerfile must assert npm is present (kept for the pi child)")
	}
}

// Every RUN body must still parse as shell after the trims were chained in.
// A broken trailing `\` would otherwise surface only at image build time.

func TestDockerfiles_RunBodiesParse(t *testing.T) {
	for _, df := range []struct {
		name, content string
	}{
		{"docker/Dockerfile", readDockerfile(t)},
		{"ui/Dockerfile", uiAsset(t, "Dockerfile")},
	} {
		for i, body := range runBodies(df.content) {
			out, err := exec.Command("sh", "-n", "-c", body).CombinedOutput()
			if err != nil {
				t.Errorf("%s RUN #%d does not parse: %v\n%s\n--- body ---\n%s", df.name, i+1, err, out, body)
			}
		}
	}
}

// runBodies returns each RUN instruction's shell text with continuation lines
// joined by their literal newline (sh treats `\`+newline as a continuation).
func runBodies(content string) []string {
	lines := strings.Split(content, "\n")
	var bodies []string
	for i := 0; i < len(lines); i++ {
		if !strings.HasPrefix(lines[i], "RUN ") {
			continue
		}
		body := []string{strings.TrimPrefix(lines[i], "RUN ")}
		for strings.HasSuffix(strings.TrimRight(body[len(body)-1], " \t"), "\\") && i+1 < len(lines) {
			i++
			body = append(body, lines[i])
		}
		bodies = append(bodies, strings.Join(body, "\n"))
	}
	return bodies
}
