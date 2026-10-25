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
	// Anchored per owning stage (issue #2053): the playwright driver trim moved
	// into the scrapling stage, so a whole-file offset would compare positions
	// across two stages that no longer share a linear order.
	pairs := []struct {
		name, stage, trim, anchor string
	}{
		{"node headers", "agent", "rm -rf /usr/include/node", "test -x /usr/bin/npm"},
		{"ast-grep duplicate", "agent", "/usr/lib/node_modules/@ast-grep/cli/node_modules", "typescript-language-server \\"},
		{"jscpd optional", "agent", "/usr/lib/node_modules/jscpd/node_modules/jscpd-linux-*", "typescript-language-server \\"},
		{"playwright driver", "scrapling", "/site-packages/playwright/driver", "beautifulsoup4 \\"},
		{"go trees", "agent", "/usr/local/go/test /usr/local/go/api", "/usr/local/go/bin/go version"},
	}
	for _, p := range pairs {
		body, ok := stageBody(content, p.stage)
		if !ok {
			t.Errorf("%s: stage %q not found", p.name, p.stage)
			continue
		}
		trimIdx := strings.Index(body, p.trim)
		anchorIdx := strings.Index(body, p.anchor)
		if trimIdx == -1 {
			t.Errorf("%s: trim %q missing", p.name, p.trim)
			continue
		}
		if anchorIdx == -1 {
			t.Errorf("%s: anchor %q missing", p.name, p.anchor)
			continue
		}
		if anchorIdx > trimIdx {
			t.Errorf("%s: trim (offset %d) must follow install anchor %q (offset %d) in stage %s", p.name, trimIdx, p.anchor, anchorIdx, p.stage)
		}
	}
}

func TestDockerfile_SizeTrimsPerStage(t *testing.T) {
	content := readDockerfile(t)
	// A trim must run in the stage that produces (and ships) the payload: in
	// the producing stage it keeps the weight out of the copied artifact, in the
	// agent stage it keeps it out of the image.
	byStage := map[string][]string{
		"scrapling": {"/site-packages/playwright/driver"},
		"agent": {
			"rm -rf /usr/include/node",
			"/usr/lib/node_modules/@ast-grep/cli/node_modules",
			"/usr/lib/node_modules/jscpd/node_modules/jscpd-linux-*",
			"rm -rf /usr/local/go/test /usr/local/go/api /usr/local/go/doc /usr/local/go/misc",
		},
	}
	for name, trims := range byStage {
		body, ok := stageBody(content, name)
		if !ok {
			t.Errorf("stage %q not found", name)
			continue
		}
		for _, trim := range trims {
			if !strings.Contains(body, trim) {
				t.Errorf("trim %q must live in stage %s", trim, name)
			}
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
	for _, df := range dockerfiles(t) {
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
	var bodies []string
	for _, r := range runInstructions(content) {
		bodies = append(bodies, r.body)
	}
	return bodies
}

// runInstr is one RUN instruction: the leading instruction flags
// (`--mount=…`, `--network=…`) and the shell body they were stripped from.
// Flag text left in the body makes `sh -n -c` exit 2 ("Illegal option --"),
// so everything that parses the shell reads body.
type runInstr struct {
	flags []string
	body  string
}

func runInstructions(content string) []runInstr {
	lines := strings.Split(content, "\n")
	var out []runInstr
	for i := 0; i < len(lines); i++ {
		if !strings.HasPrefix(lines[i], "RUN ") {
			continue
		}
		raw := []string{strings.TrimPrefix(lines[i], "RUN ")}
		for strings.HasSuffix(strings.TrimRight(raw[len(raw)-1], " \t"), "\\") && i+1 < len(lines) {
			i++
			raw = append(raw, lines[i])
		}
		flags, body := stripRunFlags(strings.Join(raw, "\n"))
		out = append(out, runInstr{flags: flags, body: body})
	}
	return out
}

// stripRunFlags peels the leading instruction flags off a RUN body. Flags may
// each sit on their own `\`-continued line, so the continuation is consumed
// too. A flag-free body is returned byte-identical.
func stripRunFlags(raw string) (flags []string, body string) {
	rest := raw
	for {
		trimmed := strings.TrimLeft(rest, " \t\n")
		if strings.HasPrefix(trimmed, "\\\n") { // end of a preceding flag line
			trimmed = strings.TrimLeft(trimmed[2:], " \t\n")
		}
		if !strings.HasPrefix(trimmed, "--") {
			if len(flags) == 0 {
				return nil, raw
			}
			return flags, trimmed
		}
		tok := trimmed
		if idx := strings.IndexAny(tok, " \t\n"); idx >= 0 {
			tok = tok[:idx]
		}
		flags = append(flags, tok)
		rest = trimmed[len(tok):]
	}
}
