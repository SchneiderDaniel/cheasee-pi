package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// goreleaserPath returns the path to .goreleaser.yml relative to the test file.
func goreleaserPath() string {
	return filepath.Join("..", "..", ".goreleaser.yml")
}

// workflowPath returns the path to release.yml relative to the test file.
func workflowPath() string {
	return filepath.Join("..", "..", ".github", "workflows", "release.yml")
}

// ---------------------------------------------------------------------------
// Phase 3: GoReleaser config validation (.goreleaser.yml)
// ---------------------------------------------------------------------------

func TestGoReleaserConfig_Exists(t *testing.T) {
	if _, err := os.Stat(goreleaserPath()); err != nil {
		t.Fatalf(".goreleaser.yml not found: %v", err)
	}
}

func TestGoReleaserConfig_Version2(t *testing.T) {
	data, err := os.ReadFile(goreleaserPath())
	if err != nil {
		t.Fatalf("reading .goreleaser.yml: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "version: 2") {
		t.Error(".goreleaser.yml must contain 'version: 2' header")
	}
}

func TestGoReleaserConfig_GoosContainsLinuxAndDarwin(t *testing.T) {
	data, err := os.ReadFile(goreleaserPath())
	if err != nil {
		t.Fatalf("reading .goreleaser.yml: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "linux") {
		t.Error(".goreleaser.yml goos must include linux")
	}
	if !strings.Contains(content, "darwin") {
		t.Error(".goreleaser.yml goos must include darwin")
	}
}

func TestGoReleaserConfig_GoarchContainsAmd64AndArm64(t *testing.T) {
	data, err := os.ReadFile(goreleaserPath())
	if err != nil {
		t.Fatalf("reading .goreleaser.yml: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "amd64") {
		t.Error(".goreleaser.yml goarch must include amd64")
	}
	if !strings.Contains(content, "arm64") {
		t.Error(".goreleaser.yml goarch must include arm64")
	}
}

func TestGoReleaserConfig_ChecksumName(t *testing.T) {
	data, err := os.ReadFile(goreleaserPath())
	if err != nil {
		t.Fatalf("reading .goreleaser.yml: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "checksums.txt") {
		t.Error(".goreleaser.yml checksum name_template must be \"checksums.txt\"")
	}
}

func TestGoReleaserConfig_CorrectOwnerAndRepo(t *testing.T) {
	data, err := os.ReadFile(goreleaserPath())
	if err != nil {
		t.Fatalf("reading .goreleaser.yml: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "owner: SchneiderDaniel") {
		t.Error(".goreleaser.yml release.github.owner must be SchneiderDaniel")
	}
	if !strings.Contains(content, "name: cheasee-pi") {
		t.Error(".goreleaser.yml release.github.name must be cheasee-pi")
	}
}

func TestGoReleaserConfig_CgoEnabled(t *testing.T) {
	data, err := os.ReadFile(goreleaserPath())
	if err != nil {
		t.Fatalf("reading .goreleaser.yml: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "CGO_ENABLED=0") {
		t.Error(".goreleaser.yml must have CGO_ENABLED=0 in builds[0].env")
	}
}

// ---------------------------------------------------------------------------
// Phase 4: Workflow config validation (release.yml)
// ---------------------------------------------------------------------------

func TestWorkflow_Exists(t *testing.T) {
	if _, err := os.Stat(workflowPath()); err != nil {
		t.Fatalf("release.yml not found: %v", err)
	}
}

func TestWorkflow_ReleaseJobHasGithubTokenEnv(t *testing.T) {
	data, err := os.ReadFile(workflowPath())
	if err != nil {
		t.Fatalf("reading release.yml: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}") {
		t.Error("release.yml release job must have GITHUB_TOKEN env on goreleaser-action step")
	}
}

func TestWorkflow_ReleaseJobHasContentsWrite(t *testing.T) {
	data, err := os.ReadFile(workflowPath())
	if err != nil {
		t.Fatalf("reading release.yml: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "contents: write") {
		t.Error("release.yml release job must have permissions.contents: write")
	}
}

func TestWorkflow_TestJobHasGoreleaserCheck(t *testing.T) {
	data, err := os.ReadFile(workflowPath())
	if err != nil {
		t.Fatalf("reading release.yml: %v", err)
	}
	content := string(data)

	// The goreleaser-action with args: check runs 'goreleaser check' to validate config
	if !strings.Contains(content, "args: check") {
		t.Error("release.yml test job should include a 'goreleaser check' step via 'args: check' to validate config on PRs")
	}
	// The check must be in the test job, not the release job
	// Find the test job section (between 'test:' and 'release:')
	testSection := extractJobSection(content, "test")
	if testSection == "" {
		t.Fatal("could not find test job section")
	}
	if !strings.Contains(testSection, "args: check") {
		t.Error("goreleaser check step (args: check) must be in the test job")
	}
}

func TestWorkflow_ReleaseJobGatedOnTag(t *testing.T) {
	data, err := os.ReadFile(workflowPath())
	if err != nil {
		t.Fatalf("reading release.yml: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "startsWith(github.ref, 'refs/tags/v')") {
		t.Error("release.yml release job must be gated on 'if: startsWith(github.ref, 'refs/tags/v')'")
	}
}

// extractJobSection extracts a YAML job section by name from the workflow content.
// It returns the content between the job name line and the next top-level key.
func extractJobSection(content, jobName string) string {
	lines := strings.Split(content, "\n")
	startIdx := -1
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if trimmed == jobName+":" && indent == 2 {
			startIdx = i
			break
		}
	}
	if startIdx == -1 {
		return ""
	}
	// Find the end: next job at same indent level (indent 2, not a list item)
	endIdx := len(lines)
	for i := startIdx + 1; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if indent == 2 && strings.Contains(trimmed, ":") && !strings.HasPrefix(trimmed, "-") {
			endIdx = i
			break
		}
	}
	return strings.Join(lines[startIdx:endIdx], "\n")
}

func TestWorkflow_ActionVersionsCurrent(t *testing.T) {
	data, err := os.ReadFile(workflowPath())
	if err != nil {
		t.Fatalf("reading release.yml: %v", err)
	}
	content := string(data)

	// actions/checkout should be @v4 or newer
	if strings.Contains(content, "actions/checkout@v3") || strings.Contains(content, "actions/checkout@v2") || strings.Contains(content, "actions/checkout@v1") {
		t.Error("actions/checkout version is too old; use @v4 or newer")
	}
	// actions/setup-go should be @v5 or newer
	if strings.Contains(content, "actions/setup-go@v4") || strings.Contains(content, "actions/setup-go@v3") || strings.Contains(content, "actions/setup-go@v2") || strings.Contains(content, "actions/setup-go@v1") {
		t.Error("actions/setup-go version is too old; use @v5 or newer")
	}
	// goreleaser-action should be @v7 or newer (required for version: 2 config compatibility)
	if strings.Contains(content, "goreleaser/goreleaser-action@v6") || strings.Contains(content, "goreleaser/goreleaser-action@v5") || strings.Contains(content, "goreleaser/goreleaser-action@v4") || strings.Contains(content, "goreleaser/goreleaser-action@v3") || strings.Contains(content, "goreleaser/goreleaser-action@v2") || strings.Contains(content, "goreleaser/goreleaser-action@v1") {
		t.Error("goreleaser/goreleaser-action must be @v7 or newer (v7 defaults to ~> v2, matching .goreleaser.yml version: 2)")
	}
}
