package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// stageBody returns the lines of the stage named `AS <name>`, exclusive of its
// FROM line, up to the next FROM (or EOF). ok=false when no such stage exists,
// so a renamed stage fails loudly instead of asserting on an empty string.
func stageBody(content, name string) (string, bool) {
	lines := strings.Split(content, "\n")
	start := -1
	for i, line := range lines {
		f := strings.Fields(line)
		if len(f) >= 4 && f[0] == "FROM" && f[len(f)-2] == "AS" && f[len(f)-1] == name {
			start = i + 1
			break
		}
	}
	if start < 0 {
		return "", false
	}
	for j := start; j < len(lines); j++ {
		if strings.HasPrefix(lines[j], "FROM ") {
			return strings.Join(lines[start:j], "\n"), true
		}
	}
	return strings.Join(lines[start:], "\n"), true
}

func stage(t *testing.T, content, name string) string {
	t.Helper()
	body, ok := stageBody(content, name)
	if !ok {
		t.Fatalf("Dockerfile must declare stage `AS %s`", name)
	}
	return body
}

func TestStageBody_SlicesStageExclusiveOfFROM(t *testing.T) {
	content := "FROM a AS one\nRUN first\nFROM b AS two\nRUN second\nFROM c AS three\nRUN third\n"
	got, ok := stageBody(content, "two")
	if !ok {
		t.Fatal("stage `two` must be found")
	}
	if got != "RUN second" {
		t.Errorf("stage body must be the stage's own lines (no FROM), got %q", got)
	}
}

func TestStageBody_LastStageRunsToEOF(t *testing.T) {
	content := "FROM a AS one\nRUN first\nFROM b AS two\nRUN second\nCMD []\n"
	got, ok := stageBody(content, "two")
	if !ok || !strings.Contains(got, "CMD []") {
		t.Errorf("the last stage must run to EOF, got %q (ok=%v)", got, ok)
	}
}

func TestStageBody_MissingStageReportsNotOK(t *testing.T) {
	if got, ok := stageBody("FROM a AS one\nRUN x\n", "missing"); ok || got != "" {
		t.Errorf("a missing stage must report ok=false and \"\", got %q (ok=%v)", got, ok)
	}
}

// The split (issue #2053): the browser bundle + python venvs live in their own
// stage so a change to any agent-stage layer copies the artifacts instead of
// re-downloading ~646M of chromium.

func TestDockerfile_ChromiumInstallOnlyInScraplingStage(t *testing.T) {
	content := readDockerfile(t)
	install := "/opt/venvs/scrapling-venv/bin/python -m patchright install chromium"
	if got := strings.Count(content, install); got != 1 {
		t.Fatalf("exactly one chromium install invocation required, got %d", got)
	}
	if !strings.Contains(stage(t, content, "scrapling"), install) {
		t.Error("the chromium download must run inside the scrapling stage")
	}
}

func TestDockerfile_ScraplingStageCarriesBrowserChain(t *testing.T) {
	content := stage(t, readDockerfile(t), "scrapling")
	for _, want := range []string{
		"python3 -m venv /opt/venvs/scrapling-venv",
		"COPY scrapling-constraints.txt",
		"browsers.json",
		browserRevisionLookup,
		browserGuardExpr,
		"chmod -R a+rX /opt/playwright-browsers",
		"ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers",
		// The 132M playwright driver trim must sit in the producing stage: an
		// intermediate layer would otherwise carry it into the agent copy.
		"rm -rf /opt/venvs/scrapling-venv/lib/python*/site-packages/playwright/driver",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("scrapling stage must contain %q", want)
		}
	}
	// The browser-archive size note (646M/arch) moves with the browser layer.
	if !strings.Contains(content, "646") {
		t.Error("scrapling stage must state the ~646M/arch browser footprint")
	}
}

func TestDockerfile_AgentStageOwnsNoPythonInstall(t *testing.T) {
	// The stage boundary is the point of the split: the agent stage copies
	// artifacts and writes runtime layout only. A pip/patchright call or the
	// revision lookup reappearing there re-couples the browser to agent-layer
	// churn — and re-deriving the revision risks #1986 drift.
	content := stage(t, readDockerfile(t), "agent")
	for _, r := range runInstructions(content) {
		for _, forbidden := range []string{"patchright install", "pip install", "browsers.json", "python3 -m venv"} {
			if strings.Contains(r.body, forbidden) {
				t.Errorf("agent stage must not run %q (it belongs to the scrapling stage): %q", forbidden, r.body)
			}
		}
	}
}

func TestDockerfile_AgentCopiesBrowserArtifacts(t *testing.T) {
	content := stage(t, readDockerfile(t), "agent")
	for _, want := range []string{
		"COPY --from=scrapling /opt/venvs/scrapling-venv /opt/venvs/scrapling-venv",
		"COPY --from=scrapling /opt/venvs/web-search-venv /opt/venvs/web-search-venv",
		"COPY --from=scrapling /opt/playwright-browsers /opt/playwright-browsers",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("agent stage must copy the artifact: %q", want)
		}
	}
}

func TestDockerfile_RuntimeEnvRedeclaredInAgentStage(t *testing.T) {
	// ENV does not cross stages: the browser path (entrypoint.sh resolves it
	// first) and the pip constraints pin must exist in the runtime stage.
	content := stage(t, readDockerfile(t), "agent")
	for _, want := range []string{
		"ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers",
		"ENV SCRAPLING_PIP_CONSTRAINTS=/opt/venvs/scrapling-constraints.txt",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("agent stage must re-declare %q (ENV does not cross stages)", want)
		}
	}
}

func TestDockerfile_VenvStampFollowsArtifactCopy(t *testing.T) {
	// The stamp hashes the venv that is actually shipped: writing it before the
	// COPY would record the producing stage's (already trimmed) tree, not the
	// copy's.
	content := stage(t, readDockerfile(t), "agent")
	copyIdx := strings.Index(content, "COPY --from=scrapling /opt/venvs/scrapling-venv")
	stampIdx := strings.Index(content, ".cheasee-venv-stamp")
	if copyIdx == -1 || stampIdx == -1 {
		t.Fatalf("agent stage must copy the venv and write its stamp (copy=%d stamp=%d)", copyIdx, stampIdx)
	}
	if copyIdx > stampIdx {
		t.Error("the venv stamp must be written after the COPY --from=scrapling")
	}
}

func TestDockerfile_AgentStageIsLast(t *testing.T) {
	content := readDockerfile(t)
	last := ""
	for _, line := range strings.Split(content, "\n") {
		if strings.HasPrefix(line, "FROM ") {
			last = line
		}
	}
	if !strings.HasSuffix(strings.Fields(last)[len(strings.Fields(last))-1], "agent") {
		t.Errorf("the final FROM must be the agent stage (it is the shipped image), got %q", last)
	}
}

func TestDockerfile_ComposeBuildTargetsSingleFile(t *testing.T) {
	// No new compose service and no build change: the CLI extracts this context
	// and builds the final (agent) stage.
	data, err := os.ReadFile(filepath.Join("embedded", "docker", "docker-compose.yml"))
	if err != nil {
		t.Fatalf("read docker-compose.yml: %v", err)
	}
	if strings.Contains(string(data), "scrapling") {
		t.Error("docker-compose.yml must not gain a scrapling service/stage knob — the split is Dockerfile-internal")
	}
}
