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

func TestRepoRoot_gitBinaryFailingWrapsError(t *testing.T) {
	stubGitRepo(t, "", "", os.ErrNotExist, true)

	_, _, err := repoRoot(t.TempDir())
	if err == nil {
		t.Fatal("expected wrapped error")
	}
	if !strings.Contains(err.Error(), "check git repository") {
		t.Errorf("error should wrap with 'check git repository': %v", err)
	}
}

func TestRepoRoot_nestedRepoInnermostToplevel(t *testing.T) {
	outer := t.TempDir()
	gitInitDir(t, outer)
	inner := filepath.Join(outer, "inner")
	gitInitDir(t, inner)

	root, _, err := repoRoot(inner)
	if err != nil {
		t.Fatalf("repoRoot: %v", err)
	}
	if root != inner {
		t.Errorf("nested repo must resolve to innermost toplevel %q, got %q", inner, root)
	}
}

func TestRepoRoot_symlinkedCwdResolvesPhysicalPrefix(t *testing.T) {
	// macOS-style: user cwd goes through a symlink (logical /tmp → physical
	// /private/tmp). repoRoot must trust git's --show-prefix (physical),
	// not filepath.Abs (logical) — the old math produced ../-laden paths.
	root := t.TempDir()
	gitInitDir(t, root)
	physical := filepath.Join(root, "real")
	if err := os.MkdirAll(physical, 0755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(physical, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	rootRes, rel, err := repoRoot(link)
	if err != nil {
		t.Fatalf("repoRoot: %v", err)
	}
	if rootRes != root {
		t.Errorf("root = %q, want %q", rootRes, root)
	}
	// git resolves the symlink: prefix is relative to the physical toplevel.
	if rel != "real" {
		t.Errorf("relCwd through symlink = %q, want %q (must not contain ..)", rel, "real")
	}
	if strings.Contains(rel, "..") {
		t.Errorf("relCwd must never contain ..: %q", rel)
	}
}

func TestRepoRoot_worktreeCheckoutReportsOwnToplevel(t *testing.T) {
	main := t.TempDir()
	gitInitDir(t, main)
	// Configure identity so worktree add works (no commits needed, but a
	// worktree requires an existing branch — create one via commit).
	exec.Command("git", "-C", main, "config", "user.email", "t@t.t").Run()
	exec.Command("git", "-C", main, "config", "user.name", "t").Run()
	exec.Command("git", "-C", main, "commit", "--allow-empty", "-q", "-m", "init").Run()

	wt := filepath.Join(t.TempDir(), "wt")
	if out, err := exec.Command("git", "-C", main, "worktree", "add", "-q", wt, "HEAD").CombinedOutput(); err != nil {
		t.Skipf("git worktree add unavailable: %v\n%s", err, out)
	}

	root, _, err := repoRoot(wt)
	if err != nil {
		t.Fatalf("repoRoot: %v", err)
	}
	if root != wt {
		t.Errorf("worktree checkout must resolve to its own toplevel %q, got %q", wt, root)
	}
}
