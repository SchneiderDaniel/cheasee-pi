package main

import (
	"context"
	"embed"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

//go:embed embedded
var embeddedFS embed.FS

// AssetFS returns the embedded filesystem containing embedded/docker/{docker-compose.yml,Dockerfile,entrypoint.sh,lib/worktree-fix.sh},
// embedded/docker/codeflow/{Dockerfile,server.py,config.json}, and the embedded/pi/
// settings template. Canonical source is embedded/docker/ (checked in, required
// by //go:embed; the build fails if the pattern matches no files). The repo-root
// docker/ tree is gone — the CLI extracts this subtree at runtime to a
// version-keyed cache dir (see cache.go / up.go). The Cheasee-Pi resource tree
// (.pi/) is NOT embedded: the Dockerfile clones the cheasee-pi repo at build
// time (ARG CHEASEE_REF), keeping the repo the single source of truth with no
// generated mirror to sync.
func AssetFS() fs.FS {
	return embeddedFS
}

// ──────────────────────────────────────────────
// Adapter: FSExtractor
// ──────────────────────────────────────────────

type FSExtractor struct {
	source fs.FS
	prefix string // walk root within FS; embedded/docker/ maps to destDir root
}

// NewExtractor creates an extractor that reads from the embedded FS.
func NewExtractor() *FSExtractor {
	return &FSExtractor{
		source: embeddedFS,
		prefix: "embedded",
	}
}

// Extract writes the docker build assets to the destDir root — the cache dir.
// The destDir root becomes the docker compose build context (`docker compose
// -f <destDir>/docker-compose.yml` with `context: .`), so:
//
//	embedded/docker/{docker-compose.yml,Dockerfile,entrypoint.sh,lib/,codeflow/} → destDir/...
//
// The embedded/pi/ settings template is NOT extracted (consumed by the
// scaffold adapter). The Cheasee-Pi resource tree is not embedded either —
// the Dockerfile clones the cheasee-pi repo into the image at build time
// (ARG CHEASEE_REF), so no resource copy has to be kept in sync. Re-extract
// overwrites cleanly — cache state is regenerable, version-keyed.
func (e *FSExtractor) Extract(ctx context.Context, destDir string) error {
	err := fs.WalkDir(e.source, e.prefix, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Compute relative path from the embedded root
		rel, err := filepath.Rel(e.prefix, path)
		if err != nil {
			return err
		}
		if rel == "." || rel == "" {
			return nil // skip root
		}

		// Skip the settings template (embedded/pi/). The scaffold adapter
		// reads it directly; it is never a docker asset.
		if rel == "pi" || strings.HasPrefix(rel, "pi/") {
			return nil
		}

		// Map embedded/docker/<rest> → destDir/<rest>: the docker subtree is
		// the build context root.
		if !strings.HasPrefix(rel, "docker/") {
			return nil
		}
		destRel := strings.TrimPrefix(rel, "docker/")

		return writeExtracted(e.source, path, filepath.Join(destDir, destRel), d.IsDir())
	})
	return err
}

// writeExtracted writes one embedded entry (dir or file) to destPath.
func writeExtracted(source fs.FS, srcPath, destPath string, isDir bool) error {
	if isDir {
		return os.MkdirAll(destPath, 0755)
	}

	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
		return fmt.Errorf("create parent dir for %s: %w", destPath, err)
	}

	srcFile, err := source.Open(srcPath)
	if err != nil {
		return fmt.Errorf("open embedded %s: %w", srcPath, err)
	}
	defer srcFile.Close()

	destFile, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("create %s: %w", destPath, err)
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, srcFile); err != nil {
		return fmt.Errorf("write %s: %w", destPath, err)
	}
	return nil
}
