package main

import (
	"os"
	"strings"
	"testing"
)

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
