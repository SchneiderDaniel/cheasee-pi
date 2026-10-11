package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// gitInitDir runs `git init` in dir using the real git binary (hermetic
// temp dir, no network).
func gitInitDir(t *testing.T, dir string) {
	t.Helper()
	if out, err := exec.Command("git", "init", "-q", dir).CombinedOutput(); err != nil {
		t.Fatalf("git init %s: %v\n%s", dir, err, out)
	}
}

// stubGitRepo replaces the git seam so repoRoot resolves to root and relCwd
// (slash-separated, no leading/trailing slash, "." at the toplevel), or —
// when inside is false — reports the dir as not a git work tree, or — when
// gitErr is set — fails the git call. Non-git commands fall through to the
// real seam.

func stubGitRepo(t *testing.T, root, relCwd string, gitErr error, inside bool) {
	t.Helper()
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "git" {
			if gitErr != nil {
				return &mockCmd{outputFn: func() ([]byte, error) { return nil, gitErr }}
			}
			if slices.Contains(arg, "--is-inside-work-tree") {
				val := "true"
				if !inside {
					val = "false"
				}
				return &mockCmd{outputFn: func() ([]byte, error) { return []byte(val), nil }}
			}
			if slices.Contains(arg, "--show-toplevel") {
				return &mockCmd{outputFn: func() ([]byte, error) { return []byte(root), nil }}
			}
			if slices.Contains(arg, "--show-prefix") {
				// git emits a trailing slash when non-empty; "" at the toplevel.
				prefix := ""
				if rel := strings.TrimPrefix(relCwd, "."); rel != "" {
					prefix = rel + "/"
				}
				return &mockCmd{outputFn: func() ([]byte, error) { return []byte(prefix), nil }}
			}
		}
		return saved(ctx, name, arg...)
	})
}

func TestRepoRoot_atRepoRoot(t *testing.T) {
	dir := t.TempDir()
	gitInitDir(t, dir)

	root, rel, err := repoRoot(dir)
	if err != nil {
		t.Fatalf("repoRoot: %v", err)
	}
	if root != dir {
		t.Errorf("root = %q, want %q", root, dir)
	}
	if rel != "." {
		t.Errorf("relCwd at root = %q, want \".\"", rel)
	}
}

func TestRepoRoot_fromSubdir(t *testing.T) {
	dir := t.TempDir()
	gitInitDir(t, dir)
	sub := filepath.Join(dir, "sub", "dir")
	if err := os.MkdirAll(sub, 0755); err != nil {
		t.Fatal(err)
	}

	root, rel, err := repoRoot(sub)
	if err != nil {
		t.Fatalf("repoRoot: %v", err)
	}
	if root != dir {
		t.Errorf("root = %q, want %q", root, dir)
	}
	// Slash-separated rel (docker -w target safe on Windows).
	if rel != "sub/dir" {
		t.Errorf("relCwd = %q, want %q", rel, "sub/dir")
	}
}

func TestRepoRoot_nonGitDirRefused(t *testing.T) {
	dir := t.TempDir() // no git init

	_, _, err := repoRoot(dir)
	if err == nil {
		t.Fatal("expected error for non-git dir")
	}
	if !strings.Contains(err.Error(), "git repository") {
		t.Errorf("error should mention git repository: %v", err)
	}
}
