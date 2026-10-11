package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRepoRoot_gitCommandPinnedToCLocale(t *testing.T) {
	// The actionable "not a git repository" error substring-matches git's
	// stderr, which git localizes (German under de_DE). gitCommand must
	// strip LC_ALL/LANG from the inherited env and pin them to C so the
	// match never depends on the user's locale — and must not leave
	// duplicate keys (their resolution varies across libc/git builds).
	t.Setenv("LANG", "de_DE.UTF-8")
	t.Setenv("LC_ALL", "de_DE.UTF-8")

	var gitCmd *mockCmd
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		gitCmd = &mockCmd{}
		return gitCmd
	})

	if _, _, err := repoRoot(t.TempDir()); err == nil {
		t.Fatal("expected error")
	}
	if gitCmd == nil {
		t.Fatal("git command was never invoked")
	}

	lcAll, lang := 0, 0
	for _, kv := range gitCmd.env {
		key, _, _ := strings.Cut(kv, "=")
		switch key {
		case "LC_ALL":
			lcAll++
			if kv != "LC_ALL=C" {
				t.Errorf("LC_ALL = %q, want pinned to C", kv)
			}
		case "LANG":
			lang++
			if kv != "LANG=C" {
				t.Errorf("LANG = %q, want pinned to C", kv)
			}
		}
	}
	if lcAll != 1 {
		t.Errorf("expected exactly one LC_ALL entry, got %d: %v", lcAll, gitCmd.env)
	}
	if lang != 1 {
		t.Errorf("expected exactly one LANG entry, got %d: %v", lang, gitCmd.env)
	}
}

func TestRepoRoot_germanLocaleNonGitDirActionable(t *testing.T) {
	// Real-git regression for the reported bug: with a German locale the
	// CLI surfaced the raw "check git repository: exit status 128" instead
	// of the actionable message, because git localizes its stderr and the
	// code matched only the English text. LC_ALL/LANG pinning must make the
	// message locale-independent. (On machines without the de_DE locale
	// compiled in, git falls back to English and the test passes either
	// way; where the locale exists it exercises the exact failure.)
	t.Setenv("LANG", "de_DE.UTF-8")
	t.Setenv("LC_ALL", "de_DE.UTF-8")

	_, _, err := repoRoot(t.TempDir()) // no git init
	if err == nil {
		t.Fatal("expected error for non-git dir")
	}
	msg := err.Error()
	if !strings.Contains(msg, "not a git repository") {
		t.Errorf("expected actionable 'not a git repository' message under German locale, got: %v", err)
	}
	if !strings.Contains(msg, "run cheasee-pi from your own git repository") {
		t.Errorf("message should carry the remedy: %v", err)
	}
	if strings.Contains(msg, "check git repository") {
		t.Errorf("raw wrapped error leaked instead of actionable message: %v", err)
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
