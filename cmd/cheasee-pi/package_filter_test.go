package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// Shared fixtures
// ──────────────────────────────────────────────

// writeRawSettings writes .pi/settings.json verbatim (no canonicalization) so
// each reconcile branch gets the exact input shape it targets.
func writeRawSettings(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".pi"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settingsPath(dir), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func readSettingsBytes(t *testing.T, dir string) []byte {
	t.Helper()
	data, err := os.ReadFile(settingsPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// readPackages returns the raw packages[] elements of .pi/settings.json.
func readPackages(t *testing.T, dir string) []json.RawMessage {
	t.Helper()
	s, err := LoadSettings(dir)
	if err != nil {
		t.Fatalf("load settings: %v", err)
	}
	raw, ok := s.extra["packages"]
	if !ok {
		t.Fatalf("no packages key in %s: %s", settingsPath(dir), readSettingsBytes(t, dir))
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatalf("packages: %v", err)
	}
	return entries
}

// assertDefaultFilterObject fails unless entry is the object form carrying the
// default source and the exact skills filter.
func assertDefaultFilterObject(t *testing.T, entry json.RawMessage) {
	t.Helper()
	var obj packageFilterObject
	if err := json.Unmarshal(entry, &obj); err != nil {
		t.Fatalf("entry is not an object (%s): %v", entry, err)
	}
	if obj.Source != defaultSkillRepos[0] {
		t.Errorf("source = %q, want %q", obj.Source, defaultSkillRepos[0])
	}
	if len(obj.Skills) != 1 || obj.Skills[0] != "!ponytail-*" {
		t.Errorf("skills = %v, want [!ponytail-*]", obj.Skills)
	}
}

func isBarePackageString(entry json.RawMessage, want string) bool {
	var s string
	return json.Unmarshal(entry, &s) == nil && s == want
}

// jsonEqual compares two JSON documents by value. Unknown extra keys survive
// Load → mutate → Save with their value intact, but a hand-edited file's
// incidental whitespace is normalized by the shared re-indenting encoder.
func jsonEqual(t *testing.T, got, want string) bool {
	t.Helper()
	var a, b any
	if err := json.Unmarshal([]byte(got), &a); err != nil {
		t.Fatalf("unmarshal %s: %v", got, err)
	}
	if err := json.Unmarshal([]byte(want), &b); err != nil {
		t.Fatalf("unmarshal %s: %v", want, err)
	}
	return reflect.DeepEqual(a, b)
}

// ──────────────────────────────────────────────
// Phase 1: filter policy (entity)
// ──────────────────────────────────────────────

func TestDefaultPackageFilters_Policy(t *testing.T) {
	if len(defaultPackageFilters) != 1 {
		t.Fatalf("expected exactly one default package filter, got %d: %+v", len(defaultPackageFilters), defaultPackageFilters)
	}
	f := defaultPackageFilters[0]
	if f.Source != defaultSkillRepos[0] {
		t.Errorf("filter source %q must be defaultSkillRepos[0] %q", f.Source, defaultSkillRepos[0])
	}
	if len(f.Skills) != 1 || f.Skills[0] != "!ponytail-*" {
		t.Errorf("filter skills = %v, want [!ponytail-*]", f.Skills)
	}
}

func TestDefaultPackageFilters_GlobKeepsCoreDropsAux(t *testing.T) {
	// pi strips the leading "!" and matches the skill's parent directory name
	// (matchesAnyPattern on SKILL.md), so the bare glob is the whole pattern.
	pattern := strings.TrimPrefix(defaultPackageFilters[0].Skills[0], "!")
	if pattern == "" {
		t.Fatalf("filter %q has no glob after the leading !", defaultPackageFilters[0].Skills[0])
	}
	for _, name := range []string{"ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"} {
		ok, err := path.Match(pattern, name)
		if err != nil || !ok {
			t.Errorf("pattern %q must exclude %q (match=%v err=%v)", pattern, name, ok, err)
		}
	}
	if ok, err := path.Match(pattern, "ponytail"); err != nil || ok {
		t.Errorf("pattern %q must keep core ponytail (match=%v err=%v)", pattern, ok, err)
	}
}

// ──────────────────────────────────────────────
// Phase 2: reconcileDefaultPackageFilters (adapter)
// ──────────────────────────────────────────────

func TestReconcileDefaultPackageFilters_AbsentFileIsNoOp(t *testing.T) {
	dir := t.TempDir()
	if err := reconcileDefaultPackageFilters(dir); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if _, err := os.Stat(settingsPath(dir)); !os.IsNotExist(err) {
		t.Errorf("start must not scaffold .pi/settings.json, got: %v", err)
	}
}

func TestReconcileDefaultPackageFilters_SeedsMissingPackagesKey(t *testing.T) {
	dir := t.TempDir()
	writeRawSettings(t, dir, `{
	"defaultProvider": "anthropic",
	"docker": {"memory": "5G", "cpus": "4.0"},
	"gitIdentity": {"name": "N", "email": "e@example.com"},
	"handAdded": {"nested": [1, 2]}
}`)
	if err := reconcileDefaultPackageFilters(dir); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	entries := readPackages(t, dir)
	if len(entries) != 1 {
		t.Fatalf("expected one seeded entry, got %d: %s", len(entries), entries)
	}
	assertDefaultFilterObject(t, entries[0])

	s, err := LoadSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.DefaultProvider != "anthropic" || s.Docker.Memory != "5G" || s.Docker.CPUs != "4.0" || s.GitIdentity.Name != "N" {
		t.Errorf("pre-existing keys must be preserved, got %+v", s)
	}
	if got := string(s.extra["handAdded"]); !jsonEqual(t, got, `{"nested": [1, 2]}`) {
		t.Errorf("unknown key must be preserved, got %s", got)
	}
}

func TestReconcileDefaultPackageFilters_UpgradesBareString(t *testing.T) {
	dir := t.TempDir()
	writeRawSettings(t, dir, `{
	"packages": [
		"https://github.com/DietrichGebert/ponytail",
		"https://github.com/SchneiderDaniel/private-pi"
	],
	"theme": "cheasee-pi"
}`)
	if err := reconcileDefaultPackageFilters(dir); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	entries := readPackages(t, dir)
	if len(entries) != 2 {
		t.Fatalf("expected the two packages kept, got %d: %s", len(entries), entries)
	}
	assertDefaultFilterObject(t, entries[0])
	if !isBarePackageString(entries[1], "https://github.com/SchneiderDaniel/private-pi") {
		t.Errorf("non-default entry must stay a bare string, got %s", entries[1])
	}
	s, err := LoadSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.Theme != "cheasee-pi" {
		t.Errorf("theme must be preserved, got %q", s.Theme)
	}
}

func TestReconcileDefaultPackageFilters_ObjectEntryNotWritten(t *testing.T) {
	dir := t.TempDir()
	// Canonical input via Settings.Save: the filter policy is already applied.
	s := &Settings{Theme: "cheasee-pi", extra: map[string]json.RawMessage{
		"packages": json.RawMessage(`["https://github.com/SchneiderDaniel/private-pi",{"source":"https://github.com/DietrichGebert/ponytail","skills":["!ponytail-*"]}]`),
	}}
	if err := s.Save(dir); err != nil {
		t.Fatal(err)
	}
	before := readSettingsBytes(t, dir)
	stamp := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(settingsPath(dir), stamp, stamp); err != nil {
		t.Fatal(err)
	}

	if err := reconcileDefaultPackageFilters(dir); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	if got := readSettingsBytes(t, dir); !bytes.Equal(before, got) {
		t.Errorf("filtered object entry must be byte-identical:\n before=%s\n after =%s", before, got)
	}
	fi, err := os.Stat(settingsPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if !fi.ModTime().Equal(stamp) {
		t.Errorf("unchanged settings must not be rewritten, mtime moved to %v", fi.ModTime())
	}
}

func TestReconcileDefaultPackageFilters_HandEditedVariantUntouched(t *testing.T) {
	for _, variant := range []string{
		"https://github.com/DietrichGebert/ponytail.git",
		"https://github.com/DietrichGebert/ponytail@v1.2.3",
	} {
		t.Run(variant, func(t *testing.T) {
			dir := t.TempDir()
			writeRawSettings(t, dir, `{"packages": ["`+variant+`"]}`)
			before := readSettingsBytes(t, dir)

			if err := reconcileDefaultPackageFilters(dir); err != nil {
				t.Fatalf("reconcile: %v", err)
			}

			got := readSettingsBytes(t, dir)
			if !bytes.Equal(before, got) {
				t.Errorf("hand-edited variant must be left untouched (no duplicate entry):\n before=%s\n after =%s", before, got)
			}
		})
	}
}

func TestReconcileDefaultPackageFilters_AppendsWhenDefaultAbsent(t *testing.T) {
	dir := t.TempDir()
	writeRawSettings(t, dir, `{"packages": ["https://github.com/SchneiderDaniel/private-pi"], "theme": "cheasee-pi"}`)
	if err := reconcileDefaultPackageFilters(dir); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	entries := readPackages(t, dir)
	if len(entries) != 2 {
		t.Fatalf("expected default object appended, got %d: %s", len(entries), entries)
	}
	if !isBarePackageString(entries[0], "https://github.com/SchneiderDaniel/private-pi") {
		t.Errorf("existing entry must be byte-preserved, got %s", entries[0])
	}
	assertDefaultFilterObject(t, entries[1])
}

func TestReconcileDefaultPackageFilters_Idempotent(t *testing.T) {
	dir := t.TempDir()
	writeRawSettings(t, dir, `{"packages": ["https://github.com/DietrichGebert/ponytail"]}`)
	if err := reconcileDefaultPackageFilters(dir); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	first := readSettingsBytes(t, dir)

	if err := reconcileDefaultPackageFilters(dir); err != nil {
		t.Fatalf("second reconcile: %v", err)
	}
	if got := readSettingsBytes(t, dir); !bytes.Equal(first, got) {
		t.Errorf("reconcile must be byte-stable:\n first =%s\n second=%s", first, got)
	}
}

func TestReconcileDefaultPackageFilters_MalformedIsErrorAndUnwrites(t *testing.T) {
	dir := t.TempDir()
	writeRawSettings(t, dir, `{"packages": [`)
	before := readSettingsBytes(t, dir)

	if err := reconcileDefaultPackageFilters(dir); err == nil {
		t.Fatal("malformed settings must be a hard error, never silently overwritten")
	}
	if got := readSettingsBytes(t, dir); !bytes.Equal(before, got) {
		t.Errorf("malformed settings must be left untouched, got %s", got)
	}
}

func TestReconcileDefaultPackageFilters_WriteFailureSurfaces(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("directory permissions do not bind as root")
	}
	dir := t.TempDir()
	writeRawSettings(t, dir, `{"packages": ["https://github.com/DietrichGebert/ponytail"]}`)
	piDir := filepath.Dir(settingsPath(dir))
	if err := os.Chmod(piDir, 0555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(piDir, 0755) })

	if err := reconcileDefaultPackageFilters(dir); err == nil {
		t.Fatal("write failure must surface, not be swallowed")
	}
}

// ──────────────────────────────────────────────
// Phase 3: runUpE wiring (use-case)
// ──────────────────────────────────────────────

func TestRunUpE_ReconcilesDefaultPackageFilterBeforeContainer(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	writeRawSettings(t, root, `{"packages": [
		"https://github.com/DietrichGebert/ponytail",
		"https://github.com/SchneiderDaniel/private-pi"
	]}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	c := stubUpFlow(t, root, false)

	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}

	entries := readPackages(t, root)
	if len(entries) != 2 {
		t.Fatalf("expected two packages, got %d: %s", len(entries), entries)
	}
	assertDefaultFilterObject(t, entries[0])
	if !isBarePackageString(entries[1], "https://github.com/SchneiderDaniel/private-pi") {
		t.Errorf("non-default entry must stay a bare string, got %s", entries[1])
	}
	if len(c.composeArgs) != 2 {
		t.Errorf("expected build + up after reconcile, got %v", c.composeArgs)
	}
	if exec.name == "" {
		t.Error("expected the container exec to be reached")
	}
}

func TestRunUpE_ReconcileFailureHaltsBeforeCompose(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	writeRawSettings(t, root, `{"packages": [`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	c := stubUpFlow(t, root, false)

	if err := runUpE(&cobra.Command{}, nil); err == nil {
		t.Fatal("malformed settings must fail the start, not pass through to the entrypoint")
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("reconcile must halt before any compose call, got %v", c.composeArgs)
	}
	if exec.name != "" {
		t.Error("reconcile must halt before the container exec")
	}
}

// TestRunUpE_ReconcilesFilterPiJustCreated covers the brand-new workspace: there
// is no .pi/settings.json to upgrade before the container starts, so the
// entrypoint's `pi install -l -a` creates it with a bare string (simulated on
// the compose stub). The post-container pass must upgrade it before pi execs.
func TestRunUpE_ReconcilesFilterPiJustCreated(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	setUpRunMode(t, root, false)
	exec := stubExecPIContainer(t)
	stubUpFlow(t, root, false)

	inner := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		r := inner(ctx, name, arg...)
		if name == "docker" && slices.Contains(arg, "compose") && slices.Contains(arg, "up") {
			// The container entrypoint's `pi install -l -a` is what first
			// creates the project settings file — pi owns it, with a bare
			// string entry.
			if m, ok := r.(*mockCmd); ok {
				m.runFn = func() error {
					writeRawSettings(t, root, `{"packages": ["`+defaultSkillRepos[0]+`"]}`)
					return nil
				}
			}
		}
		return r
	})

	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE: %v", err)
	}
	if exec.name == "" {
		t.Fatal("expected the container exec to be reached")
	}
	entries := readPackages(t, root)
	if len(entries) != 1 {
		t.Fatalf("expected one package, got %d: %s", len(entries), entries)
	}
	assertDefaultFilterObject(t, entries[0])
}

func TestRunUpE_DryRunDoesNotReconcile(t *testing.T) {
	_, root := mkWorkspace(t, `{}`)
	writeRawSettings(t, root, `{"packages": ["https://github.com/DietrichGebert/ponytail"]}`)
	before := readSettingsBytes(t, root)
	setUpRun(t, root) // dry-run
	stubUpFlow(t, root, false)

	testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err != nil {
			t.Fatalf("runUpE: %v", err)
		}
	})

	if got := readSettingsBytes(t, root); !bytes.Equal(before, got) {
		t.Errorf("dry-run must touch nothing:\n before=%s\n after =%s", before, got)
	}
}

// ──────────────────────────────────────────────
// Phase 4: preserved invariants (regression)
// ──────────────────────────────────────────────

func TestCommittedSettings_PonytailPackageFiltered(t *testing.T) {
	var doc struct {
		Packages []json.RawMessage `json:"packages"`
	}
	if err := json.Unmarshal([]byte(readCommittedSettings(t)), &doc); err != nil {
		t.Fatalf("committed settings packages: %v", err)
	}
	entries := doc.Packages
	if len(entries) < 2 {
		t.Fatalf("committed packages must keep ponytail + private-pi, got %s", entries)
	}
	assertDefaultFilterObject(t, entries[0])
	for i, entry := range entries {
		if isBarePackageString(entry, defaultSkillRepos[0]) {
			t.Errorf("entry %d is still the bare ponytail string, filter never applied: %s", i, entry)
		}
	}
	last := entries[len(entries)-1]
	if !isBarePackageString(last, "https://github.com/SchneiderDaniel/private-pi") {
		t.Errorf("private-pi must stay a bare string, got %s", last)
	}

	// The committed entry must be exactly what the reconciler considers done,
	// so `cheasee-pi start` in this repo never rewrites the file.
	s, err := loadSettingsFile(committedSettingsPath())
	if err != nil {
		t.Fatalf("load committed settings: %v", err)
	}
	changed, err := applyDefaultPackageFilters(s)
	if err != nil {
		t.Fatalf("apply filter to committed settings: %v", err)
	}
	if changed {
		t.Error("committed .pi/settings.json already carries the filter — reconcile must be a no-op")
	}
}

// committedSkillsDir is the repo's committed dogfooding skill layout (repo
// root, sibling of cmd/).
func committedSkillsDir() string {
	return filepath.Join("..", "..", ".pi", "skills")
}

// TestCommittedSkills_PonytailAuxiliaryNotLinked is the repo-layout half of the
// filter. The .pi/settings.json package filter only narrows the package
// manifest; skills under the project's .pi/skills dir register unconditionally.
// A committed link for an auxiliary ponytail skill therefore re-adds exactly
// what the filter removes, in every cheasee-pi dev session (dogfooding). The
// five top-level links were deleted with issue #1936 — this test fails if one
// returns, so the two halves cannot drift apart silently.
func TestCommittedSkills_PonytailAuxiliaryNotLinked(t *testing.T) {
	root := committedSkillsDir()
	top, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read %s: %v", root, err)
	}
	for _, e := range top {
		if strings.HasPrefix(e.Name(), "ponytail-") {
			t.Errorf("committed skill link %q bypasses the .pi/settings.json package filter — remove it (or drop the filter) so the five auxiliary skills stay unregistered", filepath.Join(root, e.Name()))
		}
	}

	// Nested links under the core skill dir are never discovered (pi stops at
	// the first SKILL.md in a directory), but they are dead weight pointing into
	// the gitignored clone — the same rule keeps them from accumulating.
	core := filepath.Join(root, "ponytail")
	nested, err := os.ReadDir(core)
	if err != nil {
		t.Fatalf("read %s: %v", core, err)
	}
	for _, e := range nested {
		if strings.HasPrefix(e.Name(), "ponytail-") {
			t.Errorf("stale nested auxiliary link %q under the core skill dir", filepath.Join(core, e.Name()))
		}
	}

	// The core skill must stay discoverable: pi registers a skill from the
	// SKILL.md in a dir named after it. Lstat, not Stat — a fresh checkout has
	// no .pi/git clone and the link is legitimately dangling, but the entry
	// itself must exist so `ln -s` in a re-clone can target it.
	if fi, err := os.Lstat(filepath.Join(core, "SKILL.md")); err != nil {
		t.Errorf("core ponytail SKILL.md must stay linked for dogfooding: %v", err)
	} else if fi.Mode()&os.ModeSymlink == 0 {
		t.Errorf("core ponytail SKILL.md must be a symlink into the package clone, got mode %s", fi.Mode())
	}
}
