package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
