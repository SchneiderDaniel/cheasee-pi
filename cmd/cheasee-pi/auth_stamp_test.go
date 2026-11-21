package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 3: authSpec — the CLI-owned credential stamp
//
// A sha256 over the file's IDENTITY (inode, size, mtime_ns), never its content.
// `cheasee-pi auth` rewrites auth.json through atomicWrite (temp + rename), so a
// credential change replaces the inode — exactly what the container's
// read-only, single-file bind mount cannot see.
// ──────────────────────────────────────────────

// writeTempAuthFile writes content to a fresh auth.json-shaped path.
func writeTempAuthFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cheasee-pi", "auth.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAuthSpec_StableAcrossCalls(t *testing.T) {
	path := writeTempAuthFile(t, `{"github_token":"`+FakeGitHubToken+`"}`)

	first, err := authSpec(path)
	if err != nil {
		t.Fatalf("authSpec: %v", err)
	}
	second, err := authSpec(path)
	if err != nil {
		t.Fatalf("authSpec (second call): %v", err)
	}
	if first != second {
		t.Errorf("unchanged file must stamp identically: %s vs %s", first, second)
	}
	if len(first) != 64 {
		t.Errorf("stamp must be 64 hex chars, got %q (%d)", first, len(first))
	}
	if strings.ToLower(first) != first {
		t.Errorf("stamp must be lowercase hex, got %q", first)
	}
}

func TestAuthSpec_ChangesOnAtomicReplace(t *testing.T) {
	// The production write path: temp file plus rename, i.e. a NEW inode. This
	// is the credential change the container cannot see without a recreate.
	path := writeTempAuthFile(t, `{"github_token":"`+FakeGitHubToken+`"}`)
	before, err := authSpec(path)
	if err != nil {
		t.Fatalf("authSpec: %v", err)
	}

	if err := atomicWrite(path, []byte(`{"github_token":"`+FakeGitHubToken+`"} `), 0600, false); err != nil {
		t.Fatalf("atomicWrite: %v", err)
	}
	after, err := authSpec(path)
	if err != nil {
		t.Fatalf("authSpec after rewrite: %v", err)
	}
	if before == after {
		t.Errorf("an atomic replace must change the stamp (inode/mtime), got %q twice", before)
	}
}

func TestAuthSpec_ChangesOnInPlaceWrite(t *testing.T) {
	path := writeTempAuthFile(t, `{"github_token":"`+FakeGitHubToken+`"}`)
	before, err := authSpec(path)
	if err != nil {
		t.Fatalf("authSpec: %v", err)
	}

	// In-place truncate-write is the pattern a live bind mount DOES see; the
	// stamp must still flip so drift detection is not blind to it.
	if err := os.WriteFile(path, []byte(`{"github_token":"`+FakeGitHubToken+`","extra":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	after, err := authSpec(path)
	if err != nil {
		t.Fatalf("authSpec after in-place write: %v", err)
	}
	if before == after {
		t.Errorf("an in-place write with a different size must change the stamp, got %q twice", before)
	}
}

func TestAuthSpec_OmitsContent(t *testing.T) {
	// The stamp derives from file identity only: no portion of a credential
	// value may be recoverable from it.
	path := writeTempAuthFile(t, `{"github_token":"`+FakeGitHubToken+`","anthropic":{"key":"`+FakeAPIKey+`"}}`)
	spec, err := authSpec(path)
	if err != nil {
		t.Fatalf("authSpec: %v", err)
	}
	for _, value := range []string{FakeGitHubToken, FakeAPIKey} {
		if strings.Contains(spec, value) {
			t.Errorf("stamp %q leaks the credential value %q", spec, value)
		}
	}
	// Accepted limit (deliberate, not asserted): two files with identical
	// inode/size/mtime_ns stamp identically even when their bytes differ. An
	// atomic replace and any in-place edit both move mtime_ns, so this needs a
	// deliberately preserved timestamp to hit — at which point no cheaper
	// content-free signal exists.
}

func TestAuthSpec_MissingFileErrors(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "cheasee-pi", "auth.json")
	spec, err := authSpec(missing)
	if err == nil {
		t.Fatalf("missing file must be an error, got (%q, nil)", spec)
	}
	if spec != "" {
		t.Errorf("missing file must not produce a stamp, got %q", spec)
	}
}
