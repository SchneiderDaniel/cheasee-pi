package main

import (
	"bytes"
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// TestFSExtractor_WritesDockerSubtree verifies that FSExtractor.Extract writes
// embedded files to <destDir>/docker/{docker-compose.yml,Dockerfile,entrypoint.sh}
// and that content matches the embedded source.
func TestFSExtractor_WritesDockerSubtree(t *testing.T) {
	ext := NewExtractor()
	destDir := t.TempDir()

	ctx := context.Background()
	if err := ext.Extract(ctx, destDir); err != nil {
		t.Fatalf("Extract failed: %v", err)
	}

	// Verify the docker/ subdirectory is created
	dockerDir := filepath.Join(destDir, "docker")
	info, err := os.Stat(dockerDir)
	if err != nil {
		t.Fatalf("docker/ subdir not created: %v", err)
	}
	if !info.IsDir() {
		t.Fatal("docker/ is not a directory")
	}

	// Verify each expected file exists and content matches AssetFS
	expectedFiles := []string{
		"docker-compose.yml",
		"Dockerfile",
		"entrypoint.sh",
	}

	assetFS := AssetFS()

	for _, name := range expectedFiles {
		embeddedPath := filepath.Join("embedded", "docker", name)
		destPath := filepath.Join(destDir, "docker", name)

		// Check destination file exists
		info, err := os.Stat(destPath)
		if err != nil {
			t.Errorf("missing extracted file %s: %v", name, err)
			continue
		}
		if info.IsDir() {
			t.Errorf("expected file but %s is a directory", name)
			continue
		}

		// Read content from embedded FS
		embeddedContent, err := fs.ReadFile(assetFS, embeddedPath)
		if err != nil {
			t.Errorf("read embedded %s: %v", embeddedPath, err)
			continue
		}

		// Read content from extracted file
		extractedContent, err := os.ReadFile(destPath)
		if err != nil {
			t.Errorf("read extracted %s: %v", destPath, err)
			continue
		}

		// Compare content byte-for-byte
		if !bytes.Equal(embeddedContent, extractedContent) {
			t.Errorf("content mismatch for %s: embedded %d bytes, extracted %d bytes",
				name, len(embeddedContent), len(extractedContent))
		}
	}
}

// TestFSExtractor_MapFSWalk verifies the WalkDir+Copy logic hermetically by
// injecting an in-memory FS: nested tree extracted byte-identical, pi/
// subtree skipped, parent dirs created.
func TestFSExtractor_MapFSWalk(t *testing.T) {
	fsys := fstest.MapFS{
		"embedded/docker/docker-compose.yml": &fstest.MapFile{Data: []byte("version: '3'\n")},
		"embedded/docker/Dockerfile":         &fstest.MapFile{Data: []byte("FROM alpine\n")},
		"embedded/docker/sub/run.sh":         &fstest.MapFile{Data: []byte("#!/bin/sh\n")},
		"embedded/pi/settings.json":          &fstest.MapFile{Data: []byte("{}")},
	}
	ext := &FSExtractor{source: fsys, prefix: "embedded"}
	destDir := t.TempDir()

	if err := ext.Extract(context.Background(), destDir); err != nil {
		t.Fatalf("Extract failed: %v", err)
	}

	// Nested tree extracted byte-identical with parent dirs created.
	got, err := os.ReadFile(filepath.Join(destDir, "docker", "sub", "run.sh"))
	if err != nil {
		t.Fatalf("read extracted docker/sub/run.sh: %v", err)
	}
	if string(got) != "#!/bin/sh\n" {
		t.Errorf("content mismatch for docker/sub/run.sh: %q", got)
	}

	// pi/ subtree skipped (consumed by scaffold, not extracted).
	if _, err := os.Stat(filepath.Join(destDir, "pi")); !os.IsNotExist(err) {
		t.Error("pi/ subtree should not be extracted to workspace")
	}
}

// TestFSExtractor_RespectsContextCancellation verifies that FSExtractor.Extract
// returns context.Canceled when the context is done before extraction begins.
func TestFSExtractor_RespectsContextCancellation(t *testing.T) {
	ext := NewExtractor()
	destDir := t.TempDir()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled

	err := ext.Extract(ctx, destDir)
	if err == nil {
		t.Fatal("expected error for cancelled context, got nil")
	}
	if !strings.Contains(err.Error(), "context canceled") {
		t.Errorf("expected context canceled error, got: %v", err)
	}
}

func TestExtract_SkipsPiSubtree(t *testing.T) {
	ext := NewExtractor()
	workdir := t.TempDir()

	if err := ext.Extract(context.Background(), workdir); err != nil {
		t.Fatalf("Extract failed: %v", err)
	}

	// docker/ should exist
	if _, err := os.Stat(filepath.Join(workdir, "docker", "docker-compose.yml")); os.IsNotExist(err) {
		t.Error("expected docker-compose.yml to be extracted")
	}

	// .pi/ should NOT be extracted (it's consumed by scaffold, not extractor)
	if _, err := os.Stat(filepath.Join(workdir, "pi")); err == nil {
		t.Error("pi/ should not be extracted to workspace")
	}
}
