package main

import (
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestDerivedNames_ownerRepoIdentity(t *testing.T) {
	// alice/foo vs bob/foo → distinct identities (owner matters, not just the
	// repo name); the same repo in two folders → one shared identity.
	parentA, rootA := mkWorkspace(t, `{}`)
	writeBareRemote(t, parentA, "https://github.com/alice/foo.git")
	parentB, rootB := mkWorkspace(t, `{}`)
	writeBareRemote(t, parentB, "https://github.com/bob/foo.git")
	parentC, rootC := mkWorkspace(t, `{}`)
	writeBareRemote(t, parentC, "https://github.com/alice/foo.git")

	if containerName(rootA) == containerName(rootB) {
		t.Error("alice/foo and bob/foo must get distinct containers")
	}
	if composeProjectName(rootA) == composeProjectName(rootB) {
		t.Error("alice/foo and bob/foo must get distinct compose projects")
	}
	if containerName(rootA) != containerName(rootC) {
		t.Error("same repo in two folders must share one container identity")
	}
	if composeProjectName(rootA) != composeProjectName(rootC) {
		t.Error("same repo in two folders must share one project identity")
	}
	if containerName(rootA) != "cheasee-pi-alice-foo" {
		t.Errorf("containerName = %q, want cheasee-pi-alice-foo", containerName(rootA))
	}
}

func TestDerivedNames_fallbackToBasename(t *testing.T) {
	// No .bare remote → workspace basename drives the identity.
	_, root := mkWorkspace(t, `{}`) // root = <parent>/ws
	if got := containerName(root); got != "cheasee-pi-ws" {
		t.Errorf("containerName = %q, want cheasee-pi-ws", got)
	}
	if got := codeflowContainerName(root); got != "codeflow-ws" {
		t.Errorf("codeflowContainerName = %q, want codeflow-ws", got)
	}
	if got := composeProjectName(root); got != "cheasee-pi-ws" {
		t.Errorf("composeProjectName = %q, want cheasee-pi-ws", got)
	}
}

func TestRepoSlug_scpLikeRemote(t *testing.T) {
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "git@github.com:alice/foo.git")
	if got := repoSlug(root); got != "alice-foo" {
		t.Errorf("repoSlug = %q, want alice-foo", got)
	}
}

func TestRepoSlug_fileURLFallsBackToBasename(t *testing.T) {
	// A file:// remote is a local path, not a remote identity: deriving
	// tmp/project from the URL's pseudo-host "localhost" would rename the
	// workspace after an unrelated path. repoSlug must fall back to the
	// workspace basename instead.
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "file://localhost/tmp/project.git")
	if got := repoSlug(root); got != filepath.Base(root) {
		t.Errorf("repoSlug = %q, want basename %q", got, filepath.Base(root))
	}
}

// ──────────────────────────────────────────────
// cheaseeImageRef (first-build gate identity)
// ──────────────────────────────────────────────

func TestCheaseeImageRef_equivalenceWithProjectName(t *testing.T) {
	// Equivalence property: the built image is <project>-<service>, so the
	// ref must always equal composeProjectName + the compose service suffix —
	// pins both derivations to one slug path.
	root := filepath.Join(t.TempDir(), "whatever")
	if got := cheaseeImageRef(root); got != composeProjectName(root)+"-cheasee-pi" {
		t.Errorf("cheaseeImageRef(%q) = %q, want %q", root, got, composeProjectName(root)+"-cheasee-pi")
	}
}

func TestCheaseeImageRef_basenameFallbackSlug(t *testing.T) {
	// No bare remote → repoSlug falls back to the workspace basename (ws):
	// exactly the image the docker-compose.yml service `cheasee-pi` builds
	// under project cheasee-pi-ws.
	_, root := mkWorkspace(t, `{}`)
	if got := cheaseeImageRef(root); got != "cheasee-pi-ws-cheasee-pi" {
		t.Errorf("cheaseeImageRef = %q, want cheasee-pi-ws-cheasee-pi", got)
	}
}

func TestCheaseeImageRef_overLongSlugFollowsProjectNotContainerCap(t *testing.T) {
	// Over-long slug: composeProjectName caps at 43 chars with a hash
	// suffix, containerName at 52 — the two truncations differ, and the
	// image name follows the PROJECT identity, so a containerName-based
	// derivation would name the wrong image.
	root := filepath.Join(t.TempDir(), strings.Repeat("x", 100))
	got := cheaseeImageRef(root)
	if got != composeProjectName(root)+"-cheasee-pi" {
		t.Errorf("over-long slug must derive from composeProjectName (43-char cap), got %q want %q", got, composeProjectName(root)+"-cheasee-pi")
	}
	if got == containerName(root)+"-cheasee-pi" {
		t.Errorf("cheaseeImageRef must NOT follow containerName's 52-char cap, got %q", got)
	}
}

// ──────────────────────────────────────────────
// codeflowHostPort (entity + use-case, probe stubbed)
// ──────────────────────────────────────────────

func TestCodeflowHostPort_derivedDeterministicInRange(t *testing.T) {
	// Hermetic: an inherited CODEFLOW_PORT would short-circuit derivation.
	t.Setenv("CODEFLOW_PORT", "")
	root := filepath.Join(t.TempDir(), "ws")
	p1, err := codeflowHostPort(root)
	if err != nil {
		t.Fatalf("codeflowHostPort: %v", err)
	}
	p2, err := codeflowHostPort(root)
	if err != nil {
		t.Fatal(err)
	}
	if p1 != p2 {
		t.Errorf("derived port must be deterministic per repo: %s vs %s", p1, p2)
	}
	n, err := strconv.Atoi(p1)
	if err != nil || n < 8470 || n > 9493 {
		t.Errorf("derived port must be in [8470, 9493], got %q", p1)
	}
}

func TestCodeflowHostPort_twoRootsDistinctPorts(t *testing.T) {
	// Hermetic: an inherited CODEFLOW_PORT would collapse both roots onto it.
	t.Setenv("CODEFLOW_PORT", "")
	// Fixed slugs whose fnv32-derived ports differ (verified: 484 vs 50).
	rootA := filepath.Join(t.TempDir(), "repo-alpha")
	rootB := filepath.Join(t.TempDir(), "repo-beta")
	pa, err := codeflowHostPort(rootA)
	if err != nil {
		t.Fatal(err)
	}
	pb, err := codeflowHostPort(rootB)
	if err != nil {
		t.Fatal(err)
	}
	if pa == pb {
		t.Errorf("two distinct repos must resolve to distinct ports, both %s", pa)
	}
}
