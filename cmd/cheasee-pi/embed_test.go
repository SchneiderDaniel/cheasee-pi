package main

import (
	"bytes"
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
