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

func TestGoReleaserConfig_GoosContainsAllTargets(t *testing.T) {
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
	if !strings.Contains(content, "windows") {
		t.Error(".goreleaser.yml goos must include windows")
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

func TestGoReleaserConfig_ArchiveFormatOverridesWindows(t *testing.T) {
	data, err := os.ReadFile(goreleaserPath())
	if err != nil {
		t.Fatalf("reading .goreleaser.yml: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "format_overrides") {
		t.Error(".goreleaser.yml archives must include format_overrides for windows .zip")
	}
	if !strings.Contains(content, "windows") && !strings.Contains(content, "zip") {
		t.Error(".goreleaser.yml format_overrides must specify goos: windows and formats: [zip]")
	}
}

// ---------------------------------------------------------------------------
// Phase 4: Workflow config validation (release.yml)
// ---------------------------------------------------------------------------
