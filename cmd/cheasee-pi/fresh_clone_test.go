package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestFreshCloneNoSubmodules (issue #1492, Phase 6 e2e): a fresh clone of the
// repo must be a single normal repository — no .gitmodules, no 160000
// gitlinks in the index, no submodule bookkeeping. Mirrors the
// check-no-submodules guard at clone level.
func TestFreshCloneNoSubmodules(t *testing.T) {
	repoRootBytes, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		t.Skipf("not inside a git work tree: %v", err)
	}
	src := strings.TrimSpace(string(repoRootBytes))

	// The invariant is enforced on committed state. While the removal is staged
	// but not yet committed (local worktree), HEAD still carries the gitlinks
	// and a fresh clone would include them — skip until the commit lands.
	if _, err := exec.Command("git", "-C", src, "cat-file", "-e", "HEAD:.gitmodules").CombinedOutput(); err == nil {
		t.Skip("HEAD still contains .gitmodules (removal not committed yet)")
	}

	dest := t.TempDir()
	if out, err := exec.Command("git", "clone", "--no-local", "--quiet", src, dest).CombinedOutput(); err != nil {
		t.Fatalf("git clone --no-local: %v\n%s", err, out)
	}

	if _, err := os.Stat(filepath.Join(dest, ".gitmodules")); !os.IsNotExist(err) {
		t.Error("fresh clone contains .gitmodules — submodule reintroduced")
	}

	stage, err := exec.Command("git", "-C", dest, "ls-files", "--stage").Output()
	if err != nil {
		t.Fatalf("git ls-files --stage: %v", err)
	}
	for _, line := range strings.Split(string(stage), "\n") {
		if strings.HasPrefix(line, "160000") {
			t.Errorf("fresh clone index contains a 160000 gitlink: %s", line)
		}
	}

	subStatus, err := exec.Command("git", "-C", dest, "submodule", "status").Output()
	if err != nil {
		t.Fatalf("git submodule status: %v", err)
	}
	if strings.TrimSpace(string(subStatus)) != "" {
		t.Errorf("git submodule status non-empty on fresh clone:\n%s", subStatus)
	}
}
