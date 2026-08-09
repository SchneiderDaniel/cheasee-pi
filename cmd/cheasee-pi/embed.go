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

// piTreeFS carries the generated pi-resources/.pi tree. The `.pi` directory
// name is excluded by the directory-embed rule (dot-names), so it needs an
// explicit pattern; the extractor merges it with embeddedFS when staging the
// bake context. Synced from the repo .pi/ via `make pi-tree`.
//
//go:embed embedded/pi-resources/.pi
var piTreeFS embed.FS

// AssetFS returns the embedded filesystem containing embedded/docker/{docker-compose.yml,Dockerfile,entrypoint.sh,lib/worktree-fix.sh},
// embedded/docker/codeflow/{Dockerfile,server.py,config.json}, the embedded/pi/
// settings template, and the generated embedded/pi-resources/ tree.
// Canonical source is embedded/docker/ (checked in, required by //go:embed);
// the repo-root docker/ tree is regenerated from it via `make docker-tree`
// and verified with `make check-docker`. The pi-resources tree is synced from
// .pi/ via `make pi-tree` and verified with `make check-pi`.
// Note: lib/auth-env.sh is no longer embedded; it is derived at runtime via
// `cheasee-pi auth envvars` (the canonical Go source).
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

// Extract writes the docker build assets to the destDir root — the cache dir —
// and stages the pi-resources tree at destDir/pi-resources/. The destDir root
// becomes the docker compose build context (`docker compose -f <destDir>/docker-compose.yml`
// with `context: .`), so:
//
//	embedded/docker/{docker-compose.yml,Dockerfile,entrypoint.sh,lib/,codeflow/} → destDir/...
//	embedded/pi-resources/...                                                   → destDir/pi-resources/...
//
// The embedded/pi/ settings template is NOT extracted (consumed by the
// scaffold adapter). A .dockerignore is written so the staged build context
// stays lean (node_modules/venvs/.git never bake into the image). Re-extract
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

		// Map embedded/docker/<rest> → destDir/<rest> (the docker subtree is
		// the build context root) and embedded/pi-resources/<rest> →
		// destDir/pi-resources/<rest> (staged for COPY into the image). The
		// .pi subtree is carried by piTreeFS (dot-names are excluded from the
		// directory embed), written by the second walk below.
		var destRel string
		switch {
		case strings.HasPrefix(rel, "docker/"):
			destRel = strings.TrimPrefix(rel, "docker/")
		case rel == "pi-resources" || strings.HasPrefix(rel, "pi-resources/"):
			destRel = rel
		default:
			return nil
		}

		return writeExtracted(e.source, path, filepath.Join(destDir, destRel), d.IsDir())
	})
	if err != nil {
		return err
	}

	// Merge the .pi resource tree (piTreeFS) into the staged pi-resources/.
	err = fs.WalkDir(piTreeFS, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if path == "." {
			return nil
		}
		// piTreeFS keeps the full embedded/pi-resources/.pi/... path.
		rel, err := filepath.Rel("embedded/pi-resources", path)
		if err != nil {
			return err
		}
		return writeExtracted(piTreeFS, path, filepath.Join(destDir, "pi-resources", rel), d.IsDir())
	})
	if err != nil {
		return err
	}
	return writeDockerIgnore(destDir)
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

// dockerIgnore guards the staged build context. pi-resources only carries the
// tracked resource dirs, so these are belt-and-braces — they keep the ~8 MB
// bake from accidentally growing into the ~460 MB naive checkout.
const dockerIgnore = `# Cheasee-Pi staged build context — keep the bake lean.
# pi-resources only carries tracked .pi resources; these guards prevent
# accidental state/venv inclusion.
.git
**/.git
node_modules
**/node_modules
.pi/sessions
**/.pi/sessions
.pi/scrapling-venv
.pi/web-search-venv
.pi/crawl4ai-venv
.pi/git
custom/
`

func writeDockerIgnore(destDir string) error {
	path := filepath.Join(destDir, ".dockerignore")
	if err := os.WriteFile(path, []byte(dockerIgnore), 0644); err != nil {
		return fmt.Errorf("write .dockerignore: %w", err)
	}
	return nil
}
