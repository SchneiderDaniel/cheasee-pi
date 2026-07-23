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

//go:generate cp ../../docker/Dockerfile embedded/docker/Dockerfile
//go:generate cp ../../docker/docker-compose.yml embedded/docker/docker-compose.yml
//go:generate cp ../../docker/entrypoint.sh embedded/docker/entrypoint.sh
//go:generate cp ../pi-guardian/main.go embedded/cmd/pi-guardian/main.go
//go:generate cp ../pi-guardian/main_test.go embedded/cmd/pi-guardian/main_test.go
//go:embed embedded
var embeddedFS embed.FS

// AssetFS returns the embedded filesystem containing embedded/docker/{docker-compose.yml,Dockerfile,entrypoint.sh,run-pi.sh,stop-pi.sh,lib/auth-env.sh,lib/worktree-fix.sh}.
func AssetFS() fs.FS {
	return embeddedFS
}

// ──────────────────────────────────────────────
// Port: Extractor
// ──────────────────────────────────────────────

// Extractor writes embedded asset files to a destination directory.
type Extractor interface {
	Extract(ctx context.Context, destDir string) error
}

// ──────────────────────────────────────────────
// Adapter: FSExtractor
// ──────────────────────────────────────────────

type FSExtractor struct {
	source fs.FS
	prefix string // walk root within FS; nested source-tree structure determines destination subtree
}

// NewExtractor creates an Extractor that reads from the embedded FS.
func NewExtractor() Extractor {
	return &FSExtractor{
		source: embeddedFS,
		prefix: "embedded",
	}
}

func (e *FSExtractor) Extract(ctx context.Context, destDir string) error {
	return fs.WalkDir(e.source, e.prefix, func(path string, d fs.DirEntry, err error) error {
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
		// Skip non-docker embedded assets (pi/ subtree).
		// The settings template is consumed directly by the scaffold adapter,
		// not extracted to the workspace.
		if strings.HasPrefix(rel, "pi") {
			return nil
		}

		destPath := filepath.Join(destDir, rel)

		if d.IsDir() {
			return os.MkdirAll(destPath, 0755)
		}

		// Ensure parent directory exists
		if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
			return fmt.Errorf("create parent dir for %s: %w", destPath, err)
		}

		srcFile, err := e.source.Open(path)
		if err != nil {
			return fmt.Errorf("open embedded %s: %w", path, err)
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
	})
}
