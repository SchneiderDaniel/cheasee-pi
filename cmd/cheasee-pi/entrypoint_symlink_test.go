package main

import (
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
	if strings.Contains(linkOwnedBody(t, content), "rm -rf") {
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

func extractLinkOwned(t *testing.T) string {
	return extractFunc(t, "link_owned")
}
