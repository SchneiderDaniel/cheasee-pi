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
		"scrapling-constraints.txt",
		"lib/worktree-fix.sh",
		"lib/patch-pi-session-warning.js",
		"codeflow/config.json",
		"codeflow/Dockerfile",
		"codeflow/server.py",
		"ui/Dockerfile",
		"ui/Cargo.toml",
		"ui/Cargo.lock",
		"ui/src/main.rs",
		"ui/src/lib.rs",
		"ui/src/app.rs",
		"ui/src/ws.rs",
		"ui/src/bridge.rs",
		"ui/src/protocol.rs",
		"ui/src/retry.rs",
		"ui/src/stream.rs",
		"ui/src/bash.rs",
		"ui/src/tool_card.rs",
		"ui/src/controls.rs",
		"ui/src/components/mod.rs",
		"ui/src/components/message.rs",
		"ui/src/components/controls.rs",
		"ui/src/components/banners.rs",
		"ui/src/components/tool_card.rs",
		"ui/src/components/bash.rs",
		"ui/src/components/queue.rs",
		"ui/src/components/session_list.rs",
		"ui/src/auth.rs",
		"ui/src/pi_process.rs",
		"ui/src/rpc/mod.rs",
		"ui/src/rpc/framing.rs",
		"ui/src/rpc/client.rs",
		"ui/src/session.rs",
		"ui/src/sessions_store.rs",
		"ui/tests/rpc_protocol.rs",
		"ui/tests/stream_assembly.rs",
		"ui/tests/event_widgets.rs",
		"ui/tests/session_controls.rs",
		"ui/tests/fixtures/PI_VERSION",
		"ui/tests/fixtures/commands.jsonl",
		"ui/tests/fixtures/responses.jsonl",
		"ui/tests/fixtures/events.jsonl",
		"ui/tests/fixtures/extension_ui.jsonl",
		"ui/provider_env_map.json",
		"ui/style/main.css",
	}

	assetFS := embeddedFS

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

// TestFSExtractor_MapFSWalk verifies the WalkDir+Copy logic hermetically by
// injecting an in-memory FS: docker/ assets flatten to the dest root, pi/
// subtree skipped.
func TestFSExtractor_MapFSWalk(t *testing.T) {
	fsys := fstest.MapFS{
		"embedded/docker/docker-compose.yml": &fstest.MapFile{Data: []byte("name: cheasee-pi\n")},
		"embedded/docker/Dockerfile":         &fstest.MapFile{Data: []byte("FROM alpine\n")},
		"embedded/docker/sub/run.sh":         &fstest.MapFile{Data: []byte("#!/bin/sh\n")},
		"embedded/pi/settings.json":          &fstest.MapFile{Data: []byte("{}")},
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
