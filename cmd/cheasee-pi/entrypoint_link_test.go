package main

import (
	"strings"
	"testing"
)

// linkOwnedBody returns the body of link_owned() (up to its closing brace at
// column 0) — the symlink plumbing whose no-delete contract the tests below pin.
func linkOwnedBody(t *testing.T, content string) string {
	t.Helper()
	start := strings.Index(content, "link_owned() {")
	if start == -1 {
		t.Fatal("entrypoint must define link_owned()")
	}
	end := strings.Index(content[start:], "\n}")
	if end == -1 {
		t.Fatal("link_owned() body must end with a closing brace at column 0")
	}
	return content[start : start+end]
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

// linkOwnedBody returns the body of link_owned() (up to its closing brace at
// column 0) — the symlink plumbing whose no-delete contract the tests below pin.

func TestEntrypoint_NoRmRf(t *testing.T) {
	content := readEntrypoint(t)
	// AC (#1609): the symlink plumbing never deletes. The venv refresh is the one
	// exception — it drops a regenerable cache copy (.pi/$v) that shadows the
	// baked venv and cannot self-heal (#1986), never user data.
	for _, line := range strings.Split(content, "\n") {
		if strings.Contains(line, "rm -rf") && !strings.Contains(line, `rm -rf "$dst"`) {
			t.Errorf("entrypoint must not rm -rf outside the venv refresh: %q", strings.TrimSpace(line))
		}
	}
}

func TestEntrypoint_PrivatePiUntouched(t *testing.T) {
	content := readEntrypoint(t)
	if strings.Contains(content, "private-pi") {
		t.Error("entrypoint must never touch private-pi (single source stays at /opt/cheasee-pi, referenced via settings.json)")
	}
}
