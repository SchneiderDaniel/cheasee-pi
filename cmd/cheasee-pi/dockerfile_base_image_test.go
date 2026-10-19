package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

type dockerfileCase struct {
	name    string
	content string
}

func dockerfileAt(t *testing.T, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("embedded", "docker", rel))
	if err != nil {
		t.Fatalf("read embedded/docker/%s: %v", rel, err)
	}
	return string(data)
}

// dockerfiles returns all three build files by their context-relative path.
func dockerfiles(t *testing.T) []dockerfileCase {
	t.Helper()
	return []dockerfileCase{
		{"Dockerfile", dockerfileAt(t, "Dockerfile")},
		{filepath.Join("ui", "Dockerfile"), dockerfileAt(t, filepath.Join("ui", "Dockerfile"))},
		{filepath.Join("codeflow", "Dockerfile"), dockerfileAt(t, filepath.Join("codeflow", "Dockerfile"))},
	}
}

// sha256Pin is a manifest-list digest pin: 64 lowercase hex chars.
var sha256Pin = regexp.MustCompile(`@sha256:[0-9a-f]{64}$`)

// unpinnedFROMs returns every FROM line whose image is not fixed by a digest.
// `${ARG}` references are resolved through the file's ARG defaults; an
// unresolvable reference is an offender (it could point anywhere).
func unpinnedFROMs(content string) []string {
	args := map[string]string{}
	for _, line := range strings.Split(content, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 || f[0] != "ARG" {
			continue
		}
		if k, v, ok := strings.Cut(f[1], "="); ok {
			args[k] = v
		}
	}
	var offenders []string
	for _, line := range strings.Split(content, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 || f[0] != "FROM" {
			continue
		}
		image := f[1]
		if strings.HasPrefix(image, "--") { // FROM --platform=… <image>
			if len(f) < 3 {
				offenders = append(offenders, line)
				continue
			}
			image = f[2]
		}
		if ref, ok := strings.CutPrefix(image, "${"); ok {
			image = args[strings.TrimSuffix(ref, "}")]
		}
		if !sha256Pin.MatchString(image) {
			offenders = append(offenders, line)
		}
	}
	return offenders
}

func TestDockerfiles_BaseImagesPinnedByDigest(t *testing.T) {
	for _, df := range dockerfiles(t) {
		froms := 0
		for _, line := range strings.Split(df.content, "\n") {
			if strings.HasPrefix(line, "FROM ") {
				froms++
			}
		}
		if froms == 0 {
			t.Errorf("%s: no FROM line found — the pin check would be vacuous", df.name)
		}
		for _, line := range unpinnedFROMs(df.content) {
			t.Errorf("%s: unpinned base image (a retag must not invalidate every downstream layer): %q", df.name, line)
		}
	}
}

func TestDockerfile_SharedBaseImageArg(t *testing.T) {
	content := readDockerfile(t)
	// Exactly one definition, pinned: both stages must resolve the identical
	// digest or the copied venv's shebangs point at an absent interpreter.
	defs := 0
	for _, line := range strings.Split(content, "\n") {
		if !strings.HasPrefix(line, "ARG BASE_IMAGE=") {
			continue
		}
		defs++
		image := strings.TrimPrefix(line, "ARG BASE_IMAGE=")
		if !strings.HasPrefix(image, "debian:12-slim@sha256:") || !sha256Pin.MatchString(image) {
			t.Errorf("ARG BASE_IMAGE must be debian:12-slim pinned by digest, got %q", image)
		}
	}
	if defs != 1 {
		t.Fatalf("exactly one 'ARG BASE_IMAGE=' required, got %d", defs)
	}
	if got := strings.Count(content, "FROM ${BASE_IMAGE}"); got != 2 {
		t.Fatalf("exactly two 'FROM ${BASE_IMAGE}' required (scrapling + agent), got %d", got)
	}
	for _, name := range []string{"scrapling", "agent"} {
		if _, ok := stageBody(content, name); !ok {
			t.Errorf("stage `AS %s` must be built from ${BASE_IMAGE}", name)
		}
	}
}

func TestUIDockerfile_BaseImagesPinned(t *testing.T) {
	content := uiAsset(t, "Dockerfile")
	for _, want := range []string{"FROM rust:1.99-bookworm@sha256:", "FROM debian:bookworm-slim@sha256:"} {
		if !strings.Contains(content, want) {
			t.Errorf("ui/Dockerfile must pin %q", want+"<64hex>")
		}
	}
	if offenders := unpinnedFROMs(content); len(offenders) > 0 {
		t.Errorf("ui/Dockerfile has unpinned base images: %q", offenders)
	}
}

func TestCodeflowDockerfile_BaseImagePinnedAndUnchanged(t *testing.T) {
	content := dockerfileAt(t, filepath.Join("codeflow", "Dockerfile"))
	if !strings.Contains(content, "FROM python:3.13-alpine@sha256:") {
		t.Error("codeflow/Dockerfile must pin python:3.13-alpine by digest")
	}
	if offenders := unpinnedFROMs(content); len(offenders) > 0 {
		t.Errorf("codeflow/Dockerfile has unpinned base images: %q", offenders)
	}
	// Nothing else in this file is cache-worthy (`apk --no-cache` already skips
	// the index download), so the pin must not come with other edits.
	for _, want := range []string{"apk add --no-cache git nodejs", "ARG CODEFLOW_REF="} {
		if !strings.Contains(content, want) {
			t.Errorf("codeflow/Dockerfile must keep %q", want)
		}
	}
}

func TestDockerfiles_NoSyntaxDirective(t *testing.T) {
	// Rejected: `# syntax=docker/dockerfile:1` adds a mutable frontend image
	// fetch to every cold build. The built-in Engine 24+ frontend parses mounts.
	for _, df := range dockerfiles(t) {
		if strings.Contains(df.content, "# syntax=") {
			t.Errorf("%s must not declare a syntax directive", df.name)
		}
	}
}

func TestUnpinnedFROMs_DetectsUnpinnedForms(t *testing.T) {
	pin := "@sha256:" + strings.Repeat("a", 64)
	cases := []struct {
		name, content string
		wantOffender  bool
	}{
		{"bare tag", "FROM debian:12-slim\n", true},
		{"no tag", "FROM debian\n", true},
		{"short digest", "FROM debian@sha256:abc\n", true},
		{"uppercase digest", "FROM debian@" + strings.ToUpper("sha256:"+strings.Repeat("a", 64)) + "\n", true},
		{"resolved arg", "ARG BASE_IMAGE=debian:12-slim@sha256:" + strings.Repeat("a", 64) + "\nFROM ${BASE_IMAGE} AS s\n", false},
		{"unresolvable arg", "FROM ${BASE_IMAGE} AS s\n", true},
		{"pinned", "FROM debian:12-slim" + pin + " AS s\n", false},
		{"pinned with platform flag", "FROM --platform=linux/amd64 debian:12-slim" + pin + "\n", false},
	}
	for _, c := range cases {
		got := unpinnedFROMs(c.content)
		if c.wantOffender != (len(got) > 0) {
			t.Errorf("%s: wantOffender=%v, got %q", c.name, c.wantOffender, got)
		}
	}
}
