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

// TestFSExtractor_WritesDockerAssets verifies that FSExtractor.Extract writes
// the embedded docker assets to the destDir root — the CLI cache dir is the
// compose build context — and that content matches the embedded source.
func TestFSExtractor_WritesDockerAssets(t *testing.T) {
	ext := NewExtractor()
	destDir := t.TempDir()

	ctx := context.Background()
	if err := ext.Extract(ctx, destDir); err != nil {
		t.Fatalf("Extract failed: %v", err)
	}

	// Docker assets land at the destDir root (context: .).
	expectedFiles := []string{
		"docker-compose.yml",
		"Dockerfile",
		"entrypoint.sh",
		"lib/worktree-fix.sh",
		"codeflow/config.json",
		"codeflow/Dockerfile",
		"codeflow/server.py",
	}

	assetFS := AssetFS()

	for _, name := range expectedFiles {
		embeddedPath := filepath.Join("embedded", "docker", name)
		destPath := filepath.Join(destDir, name)

		info, err := os.Stat(destPath)
		if err != nil {
			t.Errorf("missing extracted file %s: %v", name, err)
			continue
		}
		if info.IsDir() {
			t.Errorf("expected file but %s is a directory", name)
			continue
		}

		embeddedContent, err := fs.ReadFile(assetFS, embeddedPath)
		if err != nil {
			t.Errorf("read embedded %s: %v", embeddedPath, err)
			continue
		}
		extractedContent, err := os.ReadFile(destPath)
		if err != nil {
			t.Errorf("read extracted %s: %v", destPath, err)
			continue
		}
		if !bytes.Equal(embeddedContent, extractedContent) {
			t.Errorf("content mismatch for %s: embedded %d bytes, extracted %d bytes",
				name, len(embeddedContent), len(extractedContent))
		}
	}

	// No docker/ wrapper dir at the context root.
	if _, err := os.Stat(filepath.Join(destDir, "docker")); !os.IsNotExist(err) {
		t.Error("docker/ wrapper dir must not be created (assets flatten to context root)")
	}
}

// TestFSExtractor_StagesPiResources verifies the pi-resources tree is staged
// at the extract root for `COPY pi-resources/ /opt/cheasee-pi/`.
func TestFSExtractor_StagesPiResources(t *testing.T) {
	ext := NewExtractor()
	destDir := t.TempDir()

	if err := ext.Extract(context.Background(), destDir); err != nil {
		t.Fatalf("Extract failed: %v", err)
	}

	// The staged tree mirrors .pi/ under pi-resources/ (skills/prompts/
	// extensions/themes present; state dirs never staged). prompts/ is
	// currently empty except a gitkeep dotfile, so it has no embeddable
	// entries and is not staged as an empty dir — only dirs with content
	// are required here.
	for _, name := range []string{"pi-resources/.pi/skills", "pi-resources/.pi/extensions", "pi-resources/.pi/themes"} {
		if _, err := os.Stat(filepath.Join(destDir, name)); err != nil {
			t.Errorf("missing staged %s: %v", name, err)
		}
	}
	for _, absent := range []string{"pi-resources/.pi/sessions", "pi-resources/.pi/scrapling-venv", "pi-resources/.pi/agent"} {
		if _, err := os.Stat(filepath.Join(destDir, absent)); !os.IsNotExist(err) {
			t.Errorf("state dir %s must not be staged", absent)
		}
	}

	// The cache dir carries a .dockerignore (lean build context guard).
	data, err := os.ReadFile(filepath.Join(destDir, ".dockerignore"))
	if err != nil {
		t.Fatalf(".dockerignore missing: %v", err)
	}
	content := string(data)
	for _, pat := range []string{"node_modules", ".git", "scrapling-venv"} {
		if !strings.Contains(content, pat) {
			t.Errorf(".dockerignore should exclude %q", pat)
		}
	}
}

// TestFSExtractor_MapFSWalk verifies the WalkDir+Copy logic hermetically by
// injecting an in-memory FS: docker/ assets flatten to the dest root,
// pi-resources/ stages under pi-resources/, pi/ subtree skipped.
func TestFSExtractor_MapFSWalk(t *testing.T) {
	fsys := fstest.MapFS{
		"embedded/docker/docker-compose.yml": &fstest.MapFile{Data: []byte("name: cheasee-pi\n")},
		"embedded/docker/Dockerfile":         &fstest.MapFile{Data: []byte("FROM alpine\n")},
		"embedded/docker/sub/run.sh":         &fstest.MapFile{Data: []byte("#!/bin/sh\n")},
		"embedded/pi/settings.json":          &fstest.MapFile{Data: []byte("{}")},
		"embedded/pi-resources/.pi/skills/x": &fstest.MapFile{Data: []byte("skill\n")},
	}
	ext := &FSExtractor{source: fsys, prefix: "embedded"}
	destDir := t.TempDir()

	if err := ext.Extract(context.Background(), destDir); err != nil {
		t.Fatalf("Extract failed: %v", err)
	}

	// docker/ subtree flattens to the dest root with parent dirs created.
	got, err := os.ReadFile(filepath.Join(destDir, "sub", "run.sh"))
	if err != nil {
		t.Fatalf("read extracted sub/run.sh: %v", err)
	}
	if string(got) != "#!/bin/sh\n" {
		t.Errorf("content mismatch for sub/run.sh: %q", got)
	}
	if _, err := os.Stat(filepath.Join(destDir, "docker")); !os.IsNotExist(err) {
		t.Error("docker/ wrapper dir must not be created")
	}

	// pi-resources staged under pi-resources/.
	staged, err := os.ReadFile(filepath.Join(destDir, "pi-resources", ".pi", "skills", "x"))
	if err != nil {
		t.Fatalf("read staged pi-resources: %v", err)
	}
	if string(staged) != "skill\n" {
		t.Errorf("staged content mismatch: %q", staged)
	}

	// pi/ subtree skipped (consumed by scaffold, not extracted).
	if _, err := os.Stat(filepath.Join(destDir, "pi")); !os.IsNotExist(err) {
		t.Error("pi/ subtree should not be extracted")
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

// TestExtract_SkipsPiSubtree verifies the real extractor never extracts the
// embedded/pi/ settings template into the cache dir.
func TestExtract_SkipsPiSubtree(t *testing.T) {
	ext := NewExtractor()
	workdir := t.TempDir()

	if err := ext.Extract(context.Background(), workdir); err != nil {
		t.Fatalf("Extract failed: %v", err)
	}

	// docker-compose.yml should be at the extract root.
	if _, err := os.Stat(filepath.Join(workdir, "docker-compose.yml")); os.IsNotExist(err) {
		t.Error("expected docker-compose.yml to be extracted")
	}

	// pi/ should NOT be extracted (it's consumed by scaffold, not extractor)
	if _, err := os.Stat(filepath.Join(workdir, "pi")); err == nil {
		t.Error("pi/ should not be extracted to the cache dir")
	}
}

// TestFSExtractor_ReExtractOverwrites verifies cache state is regenerable:
// a second extraction overwrites cleanly (byte-identical result).
func TestFSExtractor_ReExtractOverwrites(t *testing.T) {
	ext := NewExtractor()
	destDir := t.TempDir()

	if err := ext.Extract(context.Background(), destDir); err != nil {
		t.Fatalf("first Extract failed: %v", err)
	}
	first, err := os.ReadFile(filepath.Join(destDir, "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}

	// Corrupt the file, then re-extract: must be byte-identical again.
	if err := os.WriteFile(filepath.Join(destDir, "docker-compose.yml"), []byte("garbage"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := ext.Extract(context.Background(), destDir); err != nil {
		t.Fatalf("second Extract failed: %v", err)
	}
	second, err := os.ReadFile(filepath.Join(destDir, "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Error("re-extract must restore the original content")
	}
}
