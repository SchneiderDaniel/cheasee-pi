package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// extractSymlinkLoop pulls the actual nested symlink loop out of the
// Dockerfile's resource-symlink RUN layer — `for t in skills prompts
// extensions themes; do … done; done` — so behavioral checks execute the
// production command, never a test-side copy (audit: extract-or-execute).
func extractSymlinkLoop(t *testing.T) string {
	t.Helper()
	content := readDockerfile(t)
	start := strings.Index(content, "for t in skills prompts extensions themes; do ")
	if start < 0 {
		t.Fatal("Dockerfile must define the nested resource symlink loop")
	}
	rel := content[start:]
	// The loop is a single shell command whose terminal token `done; done`
	// occurs exactly once inside it (inner+outer loop close back to back).
	end := strings.Index(rel, "done; done")
	if end < 0 {
		t.Fatal("nested symlink loop must terminate with `done; done`")
	}
	return rel[:end+len("done; done")]
}

// runSymlinkLoop executes the Dockerfile's actual symlink loop in real bash,
// with the baked /opt + /home paths swapped for fixture src/dst (mirrors the
// runBrowserGuard path-substitution precedent). Returns the number of links
// created under dst.
func runSymlinkLoop(t *testing.T, src, dst string) (int, error) {
	t.Helper()
	loop := extractSymlinkLoop(t)
	loop = strings.ReplaceAll(loop, "/opt/cheasee-pi/.pi", `"$src"`)
	loop = strings.ReplaceAll(loop, "/home/agentuser/.pi/agent", `"$dst"`)
	script := "set -e\nsrc=\"$1\"; dst=\"$2\"\n" + loop + "\nfind \"$dst\" -type l | wc -l\n"
	out, err := exec.Command("bash", "-c", script, "bash", src, dst).CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("%v (%s)", err, out)
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return 0, fmt.Errorf("parse link count %q: %v", out, err)
	}
	return n, nil
}

func TestDockerfile_SymlinkLoopRunsWithEmptyGlob(t *testing.T) {
	// Behavioral check of the DOCKERFILE'S ACTUAL nested loop (extracted from
	// the RUN layer, paths swapped for a fixture) in real bash: an EMPTY
	// resource dir (e.g. .pi/prompts this checkout) must not kill the
	// &&-chained RUN — the inner `[ -e "$d" ] || continue` guard turns an
	// unmatched glob into a no-op, links are created for non-empty dirs only.
	root := t.TempDir()
	src := filepath.Join(root, "src")
	dst := filepath.Join(root, "dst")
	for _, d := range []string{"skills", "prompts", "extensions", "themes"} {
		if err := os.MkdirAll(filepath.Join(src, d), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(dst, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// prompts stays empty; the other three each carry one entry.
	for _, d := range []string{"skills", "extensions", "themes"} {
		if err := os.WriteFile(filepath.Join(src, d, "entry"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	n, err := runSymlinkLoop(t, src, dst)
	if err != nil {
		t.Fatalf("nested symlink loop failed with an empty resource dir: %v", err)
	}
	if n != 3 {
		t.Errorf("expected 3 links (prompts empty → none), got %d", n)
	}
}

func TestDockerfile_SymlinkLoopNoNestingOnDirTarget(t *testing.T) {
	// ln -sfn's -n is load-bearing: re-linking a symlink that points at a
	// directory must replace the link, never write the new link inside the
	// old target dir (ln's default dereferences symlink-to-directory). Runs
	// the DOCKERFILE'S ACTUAL loop (extracted, fixture paths) twice over the
	// same tree: the second pass re-links over symlinks whose targets are
	// dirs — nesting would surface as a link leaked into the src tree.
	root := t.TempDir()
	src := filepath.Join(root, "src")
	dst := filepath.Join(root, "dst")
	for _, d := range []string{"skills", "prompts", "extensions", "themes"} {
		for _, base := range []string{src, dst} {
			if err := os.MkdirAll(filepath.Join(base, d), 0o755); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Entries are DIRECTORIES: the links created point at dir targets, the
	// -n pitfall. prompts stays empty (also re-verifies the empty-glob guard
	// on the second pass).
	for _, d := range []string{"skills", "extensions", "themes"} {
		if err := os.MkdirAll(filepath.Join(src, d, "entry"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := runSymlinkLoop(t, src, dst); err != nil {
		t.Fatalf("first pass failed: %v", err)
	}
	n, err := runSymlinkLoop(t, src, dst)
	if err != nil {
		t.Fatalf("second pass failed: %v", err)
	}
	if n != 3 {
		t.Errorf("second pass must replace links in place (ln -sfn, no write-through): expected 3 links, got %d", n)
	}
	// Without -n, the second pass would have written the new links INSIDE the
	// old dir targets — i.e. into the src tree. No symlink may appear there.
	out, err := exec.Command("bash", "-c", `find "$1" -type l | wc -l`, "bash", src).CombinedOutput()
	if err != nil {
		t.Fatalf("count src links: %v", err)
	}
	if got := strings.TrimSpace(string(out)); got != "0" {
		t.Errorf("re-pointing must not write through dir-target symlinks: %s link(s) leaked into the src tree", got)
	}
}
