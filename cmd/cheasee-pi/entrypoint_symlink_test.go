package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 2: symlink re-pointing — re_point()
// ──────────────────────────────────────────────

func TestEntrypoint_DefinesRepoint(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "re_point() {") {
		t.Error("entrypoint must define re_point()")
	}
	for _, subdir := range []string{"skills", "extensions", "prompts", "themes"} {
		if !strings.Contains(content, "re_point "+subdir+" /workspaces/main/.pi/"+subdir) {
			t.Errorf("re_point must be invoked for the %q resource dir", subdir)
		}
	}
}

func TestEntrypoint_SymlinkOnlyRelink(t *testing.T) {
	content := readEntrypoint(t)
	// The link semantics live in link_owned: re-link only under a [ -L guard,
	// via ln -sfn; re_point delegates each repo entry to it.
	if !strings.Contains(content, "[ -L \"$link\" ]") {
		t.Error("link_owned must re-link only under a [ -L \"$link\" ] guard")
	}
	if !strings.Contains(content, "ln -sfn \"$target\" \"$link\"") {
		t.Error("link_owned must re-point via ln -sfn against the target")
	}
	if !strings.Contains(content, "link_owned \"$agent_dir/$name\" \"$d\"") {
		t.Error("re_point must delegate each repo entry to link_owned")
	}
}

func TestEntrypoint_NoOpOnSameTarget(t *testing.T) {
	content := readEntrypoint(t)
	// link_owned's readlink idempotency: skip when the link already points at
	// the target (no churn across restarts).
	if !strings.Contains(content, "readlink \"$link\"") {
		t.Error("link_owned must readlink the existing link to detect no-op")
	}
	if !strings.Contains(content, "= \"$target\"") {
		t.Error("link_owned must skip when readlink already equals the target")
	}
}

func TestEntrypoint_MissingTargetGuard(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "[ -e \"$d\" ] || continue") {
		t.Error("re_point must guard each repo entry with [ -e \"$d\" ] (no dangling links)")
	}
}

func TestEntrypoint_NoRmRf(t *testing.T) {
	content := readEntrypoint(t)
	if strings.Contains(content, "rm -rf") {
		t.Error("entrypoint must not rm -rf anything (AC: no container FS mutation)")
	}
}

func TestEntrypoint_PrivatePiUntouched(t *testing.T) {
	content := readEntrypoint(t)
	if strings.Contains(content, "private-pi") {
		t.Error("entrypoint must never touch private-pi (single source stays at /opt/cheasee-pi, referenced via settings.json)")
	}
}

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

func TestEntrypoint_DefinesRepointFile(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "re_point_file() {") {
		t.Error("entrypoint must define re_point_file()")
	}
	// Invocation must sit inside the is_cheasee_pi_repo block (definition
	// legitimately precedes it) and carry both paths.
	const invocation = "re_point_file /home/agentuser/.pi/agent/APPEND_SYSTEM.md /workspaces/main/APPEND_SYSTEM.md"
	idx := strings.Index(content, "if is_cheasee_pi_repo; then")
	if idx < 0 {
		t.Fatal("entrypoint must contain the is_cheasee_pi_repo block")
	}
	if !strings.Contains(content[idx:], invocation) {
		t.Error("re_point_file must be invoked inside the is_cheasee_pi_repo block with both paths")
	}
}

func TestEntrypoint_RepointFileContract(t *testing.T) {
	content := readEntrypoint(t)
	// The single-file contract lives in link_owned (shared primitives) plus a
	// thin re_point_file wrapper that keeps the missing-repo-file guard.
	for _, want := range []string{
		"[ -L \"$link\" ]",                       // re-link only under a [ -L ] guard
		"readlink \"$link\"",                     // readlink no-op detection
		"= \"$target\"",                          // skip when already at the target
		"ln -sfn \"$target\" \"$link\"",          // re-point with ln -sfn
		"chown -h agentuser:agentuser \"$link\"", // chown -h the link
		"[ -e \"$repo_file\" ] || return 0",      // missing repo file → baked link stays
		"link_owned \"$agent_file\" \"$repo_file\"",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("re_point_file must honor the re_point contract (%q)", want)
		}
	}
}

func TestEntrypoint_RepointFileConflictRefusal(t *testing.T) {
	content := readEntrypoint(t)
	// A real file at the link name must be left untouched — link_owned may
	// only create a link when nothing occupies the link name (elif branch).
	if !strings.Contains(content, "elif [ ! -e \"$link\" ]") {
		t.Error("link_owned must create missing links only when nothing occupies the link name")
	}
	if strings.Contains(content, "rm -rf") {
		t.Error("link_owned must not rm -rf anything (AC: no container FS mutation)")
	}
}

// ──────────────────────────────────────────────
// Phase 2c: extracted link_owned helper + venv loop (#1609)
// ──────────────────────────────────────────────

func TestEntrypoint_LinkOwnedDefinedAndUsed(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "link_owned() {") {
		t.Error("entrypoint must define link_owned()")
	}
	// All three call sites must route through the helper (re_point delegation,
	// the re_point_file wrapper, the custom/ block).
	for _, want := range []string{
		"link_owned \"$agent_dir/$name\" \"$d\"",
		"link_owned \"$agent_file\" \"$repo_file\"",
		"link_owned /home/agentuser/.pi/agent/custom /workspaces/main/custom",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("link_owned must be used by all three call sites (%q)", want)
		}
	}
}

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
func extractLinkOwned(t *testing.T) string {
	return extractFunc(t, "link_owned")
}

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

func TestEntrypoint_DefinesPruneStaleRepoLinks(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "prune_stale_repo_links() {") {
		t.Error("entrypoint must define prune_stale_repo_links()")
	}
	// The prune must run from re_point, after the re-point loop, so every
	// resource dir (skills, extensions, prompts, themes) inherits it.
	if !strings.Contains(content, "prune_stale_repo_links \"$agent_dir\" \"$repo_dir\"") {
		t.Error("re_point must prune stale repo links after re-pointing")
	}
}

func TestEntrypoint_PruneScopeIsSymlinkOnly(t *testing.T) {
	content := readEntrypoint(t)
	// Ownership guard: only symlinks are candidates, and only when readlink
	// lands under the live repo dir — baked /opt, private-pi and user links
	// must survive.
	for _, want := range []string{
		"[ -L \"$link\" ] || continue",
		"\"$repo_dir\"/*)",
		"[ -e \"$repo_dir/$name\" ] || [ -L \"$repo_dir/$name\" ]",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("prune_stale_repo_links must honor the scope contract (%q)", want)
		}
	}
}

func TestEntrypoint_PruneStaleRepoLinksBehavior(t *testing.T) {
	// Execute the production function text (extract-and-execute) against a real
	// layout: a live source survives, a deleted source is pruned, a dangling
	// source symlink still owned by the repo survives, and links outside the
	// repo (baked /opt) plus real files at the link name are never touched.
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	agent := filepath.Join(root, "agent")
	baked := filepath.Join(root, "opt", "ponytail")
	for _, d := range []string{repo, agent} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// Live source entry and a dangling source symlink the repo still owns.
	if err := os.MkdirAll(filepath.Join(repo, "kept"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "missing-clone"), filepath.Join(repo, "dangling-source")); err != nil {
		t.Fatal(err)
	}
	// Agent-dir links: keep, dangling-source, stale (source never existed),
	// baked (outside the repo), and a real file at the link name.
	for name, target := range map[string]string{
		"kept":            filepath.Join(repo, "kept"),
		"dangling-source": filepath.Join(repo, "dangling-source"),
		"gone":            filepath.Join(repo, "gone"),
		"baked":           baked,
	} {
		if err := os.Symlink(target, filepath.Join(agent, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(agent, "real"), []byte("real"), 0o644); err != nil {
		t.Fatal(err)
	}

	body := fmt.Sprintf(`
agent=%s	repo=%s	baked=%s
prune_stale_repo_links "$agent" "$repo"
[ -L "$agent/kept" ] && [ "$(readlink "$agent/kept")" = "$repo/kept" ]
[ -L "$agent/dangling-source" ]
[ ! -e "$agent/gone" ] && [ ! -L "$agent/gone" ]
[ -L "$agent/baked" ] && [ "$(readlink "$agent/baked")" = "$baked" ]
[ -f "$agent/real" ] && [ ! -L "$agent/real" ]
 echo OK
`, shq(agent), shq(repo), shq(baked))
	out, err := runBashScript(t, funcScript(t, "prune_stale_repo_links", body))
	assertOK(t, out, err, "prune_stale_repo_links behavioral check")
}
