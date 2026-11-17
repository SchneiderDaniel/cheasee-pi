package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// Shared fixtures for the retirement suite (retire_packages_test.go,
// migrate_test.go, up_flow_test.go). One builder, so every test starts from the
// same stale workspace, so a failure names one shape instead of five.
// ──────────────────────────────────────────────

// stalePackageObject is the object form the retired harness wrote into
// `.pi/settings.json`: the package source plus the exact skill filter it
// installed. This pair is the fingerprint that lets the migration act on its
// own instead of asking.
const stalePackageObject = `{"source": "` + ponytailSource + `", "skills": ["!ponytail-*"]}`

// stalePackageBare is the bare-string form `pi install -l` records. It carries
// no harness fingerprint, so it is the shape the migration must not remove
// without explicit confirmation.
const stalePackageBare = `"` + ponytailSource + `"`

// Unrelated entries every fixture carries next to the stale ones: the migration
// must leave both — plus the clones behind them — untouched.
const (
	keptPackageSource = "https://github.com/acme/kept-package"
	keptSkillRepo     = "https://github.com/acme/kept-skills"
)

// keptSiblingClone is a second checkout under the same owner directory as the
// retired clone: deleting the owner directory instead of the exact clone would
// destroy it.
const keptSiblingClone = ".pi/git/github.com/DietrichGebert/other"

// keptSkillClone is the checkout of an unrelated skill repository.
const keptSkillClone = ".pi/git/github.com/acme/kept-skills"

// staleWorkspace builds an initialized workspace carrying the retired package
// everywhere an earlier release put it: the harness object form in
// `.pi/settings.json`, the exact seed in `cheasee-settings.json` `skillRepos`,
// plus the project-local clone. An unrelated package entry, an unrelated skill
// repo, an unknown top-level key plus two unrelated clones sit next to them, so
// every caller can prove they survive.
func staleWorkspace(t *testing.T) string {
	t.Helper()
	return staleWorkspaceWith(t,
		`{"source": "`+keptPackageSource+`", "skills": ["!kept-*"]}, `+stalePackageObject,
		`"`+keptSkillRepo+`", "`+ponytailSource+`"`)
}

// staleWorkspaceWith is staleWorkspace taking caller-supplied array bodies: the
// `packages` elements plus the `skillRepos` specs, comma-separated. It always
// writes the clone tree, so a test only varies the registration shape. The
// workspace is `<parent>/ws` beside the sibling `.bare` the start flow verifies,
// so both the use case plus a full start can run against it.
func staleWorkspaceWith(t *testing.T, packages, skillRepos string) string {
	t.Helper()
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(parent, ".bare"), 0o755); err != nil {
		t.Fatalf("mkdir .bare: %v", err)
	}
	testutil.WriteCheaseeSettingsFile(t, root,
		`{"skillRepos": [`+skillRepos+`], "customKey": {"a": 1}}`)
	testutil.WriteSettingsFile(t, root,
		`{"packages": [`+packages+`], "defaultModel": "kept-model"}`)
	writeCloneFile(t, root, ponytailClonePath)
	writeCloneFile(t, root, keptSiblingClone)
	writeCloneFile(t, root, keptSkillClone)
	canonicalizeSettings(t, root)
	return root
}

// writeCloneFile creates one file inside a project-local clone directory, the
// way `pi install -l` leaves a checkout behind.
func writeCloneFile(t *testing.T, root, rel string) {
	t.Helper()
	dir := filepath.Join(root, rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", rel, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.js"), []byte("// "+rel+"\n"), 0o644); err != nil {
		t.Fatalf("write %s/index.js: %v", rel, err)
	}
}

// canonicalizeSettings rewrites both settings files through the production save
// path. Byte-identity assertions must compare like with like: the migration
// re-encodes a file it changes, so only a fixture already in that encoding can
// prove an unrelated entry's bytes survived the run unchanged.
func canonicalizeSettings(t *testing.T, root string) {
	t.Helper()
	if s, err := LoadSettings(root); err == nil {
		if err := s.Save(root); err != nil {
			t.Fatalf("canonicalize .pi/settings.json: %v", err)
		}
	} else if !os.IsNotExist(err) {
		t.Fatalf("load .pi/settings.json: %v", err)
	}
	c, err := LoadCheaseeSettings(root)
	if err != nil {
		t.Fatalf("load cheasee-settings.json: %v", err)
	}
	if err := c.Save(root); err != nil {
		t.Fatalf("canonicalize cheasee-settings.json: %v", err)
	}
}

// settingsBytesFile is one settings file's raw content, keyed for the
// before/after comparison an unchanged-file assertion needs.
func readBytes(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return data
}

// piSettingsFile / cheaseeSettingsFile are the two paths every assertion names.
func piSettingsFile(root string) string      { return settingsPath(root) }
func cheaseeSettingsFile(root string) string { return cheaseeSettingsPath(root) }

// assertAbsent fails while path exists — Lstat, so a dangling symlink does not
// pass for a deleted clone.
func assertAbsent(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Errorf("%s must be absent, lstat err = %v", path, err)
	}
}

// assertPresent fails while path is missing.
func assertPresent(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); err != nil {
		t.Errorf("%s must exist: %v", path, err)
	}
}

// assertBytesUnchanged fails while path's content differs from want.
func assertBytesUnchanged(t *testing.T, path string, want []byte) {
	t.Helper()
	got := readBytes(t, path)
	if string(got) != string(want) {
		t.Errorf("%s must be byte-identical\nwant:\n%s\ngot:\n%s", path, want, got)
	}
}

// claimLiveSessionID publishes an in-use claim for the workspace the way a
// running `cheasee-pi start` does, so the retirement guard sees a live session.
func claimLiveSessionID(t *testing.T, root, id string) string {
	t.Helper()
	dir := filepath.Join(root, ".pi", "sessions", filepath.Base(inUseClaimDir))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir claim dir: %v", err)
	}
	path := filepath.Join(dir, id)
	if err := os.WriteFile(path, []byte(`{"container":"cheasee-pi"}`), 0o644); err != nil {
		t.Fatalf("write claim: %v", err)
	}
	return path
}

// cleanWorkspace is the converged state: no deprecated registration anywhere,
// no leftover checkout, so a start must print nothing plus write nothing.
func cleanWorkspace(t *testing.T) string {
	t.Helper()
	root := staleWorkspaceWith(t, `"`+keptPackageSource+`"`, `"`+keptSkillRepo+`"`)
	if err := os.RemoveAll(filepath.Join(root, ponytailClonePath)); err != nil {
		t.Fatalf("clear the retired clone: %v", err)
	}
	return root
}
