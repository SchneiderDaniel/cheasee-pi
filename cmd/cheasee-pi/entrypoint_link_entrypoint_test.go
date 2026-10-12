package main

import (
	"os/exec"
	"strings"
	"testing"
)

func TestEntrypoint_CustomDirLink(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "/workspaces/main/custom") {
		t.Error("whole-dir custom/ must be re-pointed at /workspaces/main/custom when present")
	}
	if !strings.Contains(content, "/home/agentuser/.pi/agent/custom") {
		t.Error("custom/ re-point must target /home/agentuser/.pi/agent/custom")
	}
}

func TestEntrypoint_SkipsDotfiles(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "== .* ]]") {
		t.Error("re_point must skip dotfiles (.gitkeep) in repo resource dirs")
	}
}

// ──────────────────────────────────────────────
// Phase 2b: single-file re-pointing — re_point_file()
// ──────────────────────────────────────────────

func TestEntrypoint_ChownNewLinks(t *testing.T) {
	content := readEntrypoint(t)
	// The repeated `chown -h … || true` swallow concentrates in link_owned.
	if !strings.Contains(content, "chown -h agentuser:agentuser \"$link\"") {
		t.Error("link_owned must chown -h each re-pointed link to agentuser")
	}
}

// extractLinkOwned pulls the actual link_owned() function definition out of
// entrypoint.sh (from `link_owned() {` to the closing brace at column 0) so
// behavioral checks execute the production function, never a test-side copy
// (audit: extract-or-execute).

func TestEntrypoint_LinkOwnedBehavior(t *testing.T) {
	// link_owned's low-level primitives in real bash, running the function text
	// EXTRACTED from entrypoint.sh: create-when-absent, re-point-when-
	// target-differs, no-op when readlink already equals the target, and a real
	// file at the link name left untouched (conflict refusal — never over a
	// real file/dir, never rm -rf). chown -h in the extracted body fails
	// harmlessly here (2>/dev/null || true swallow is part of the production
	// function).
	body := `
root="$1"; t1="$root/t1"; t2="$root/t2"; l="$root/link"
mkdir -p "$t1" "$t2"
link_owned "$l" "$t1"                                   # create when absent
[ -L "$l" ] && [ "$(readlink "$l")" = "$t1" ]
link_owned "$l" "$t2"                                   # re-point when differs
[ "$(readlink "$l")" = "$t2" ]
link_owned "$l" "$t2"                                   # no-op when same target
[ "$(readlink "$l")" = "$t2" ]
echo "real file" > "$root/real"
link_owned "$root/real" "$t1"                           # conflict refusal
[ ! -L "$root/real" ] && [ "$(cat "$root/real")" = "real file" ]
echo OK
`
	script := "set -e\n" + extractLinkOwned(t) + body
	root := t.TempDir()
	out, err := exec.Command("bash", "-c", script, "bash", root).CombinedOutput()
	if err != nil {
		t.Fatalf("link_owned behavioral check failed: %v (%s)", err, out)
	}
	if got := strings.TrimSpace(string(out)); got != "OK" {
		t.Errorf("link_owned behavioral check = %q, want OK", got)
	}
}

// ──────────────────────────────────────────────
// Phase 2d: stale-link pruning — prune_stale_repo_links() (#1936)
// ──────────────────────────────────────────────
