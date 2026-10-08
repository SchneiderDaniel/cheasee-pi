package main

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestCodeFlowServer_TrackedSetSurvivesForeignOwnership is the #1935 follow-up
// regression: mounting the sibling bare repo fixed the dangling worktree
// gitdir, but the sidecar still runs as root over host-owned bind mounts, so
// git aborts `ls-files` with "fatal: detected dubious ownership"
// (CVE-2022-24765) and the tracked set comes back empty. Reproduces that
// root-on-foreign-repo condition without a second uid: the shim must opt in
// with `-c safe.directory=*` and still return the index paths.
func TestCodeFlowServer_TrackedSetSurvivesForeignOwnership(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	src, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/server.py")
	if err != nil {
		t.Fatalf("read embedded server.py: %v", err)
	}
	dir := t.TempDir()
	serverPath := filepath.Join(dir, "server.py")
	if err := os.WriteFile(serverPath, src, 0644); err != nil {
		t.Fatalf("write server.py: %v", err)
	}

	repoRoot := t.TempDir()
	writeFile(t, repoRoot, ".gitignore", "ignored/\n")
	writeFile(t, repoRoot, filepath.Join("ignored", "x.txt"), "x\n")
	writeFile(t, repoRoot, "tracked.txt", "t\n")
	if out, err := exec.Command("git", "-C", repoRoot, "init", "-q").CombinedOutput(); err != nil {
		t.Skipf("git init failed: %v\n%s", err, out)
	}
	if out, err := exec.Command("git", "-C", repoRoot, "add", "tracked.txt").CombinedOutput(); err != nil {
		t.Fatalf("git add tracked.txt: %v\n%s", err, out)
	}

	script := `import contextlib, io, os, runpy, sys

# Reproduce the sidecar's root-on-host-owned-mount condition without a second uid.
os.environ["GIT_TEST_ASSUME_DIFFERENT_OWNER"] = "1"
m = runpy.run_path(sys.argv[1])
g = m["_scan"].__globals__
g["REPO_ROOT"] = sys.argv[2]
g["_GIT_WARNED"] = False
buf = io.StringIO()
with contextlib.redirect_stderr(buf):
    out = g["_tracked_paths"]()
assert out == ["tracked.txt"], out
assert buf.getvalue() == "", buf.getvalue()
print("OK")
`
	scriptPath := filepath.Join(dir, "check_foreign_owner.py")
	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		t.Fatalf("write check script: %v", err)
	}
	out, err := exec.Command(python, scriptPath, serverPath, repoRoot).CombinedOutput()
	if err != nil {
		t.Fatalf("foreign-ownership gitignore checks failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "OK") {
		t.Fatalf("unexpected helper output: %s", out)
	}
}
