package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// initSplitFiles are the files produced by the init.go responsibility split.
// Any new file added to this set must also be added to the nbnc check below.
var initSplitFiles = []string{
	"init.go",
	"init_auth.go",
	"init_clone.go",
	"init_prompt.go",
	"init_scaffold.go",
}

// wantInitDecls is the full inventory of top-level declarations in the four
// init*.go files, mapped to their target file. It mirrors the split plan: a
// decl placed in the wrong file (or renamed) fails the test.
var wantInitDecls = map[string]string{
	"const:nextStepHint": "init.go",
	"const:initTimeout":  "init.go",
	"var:initAPIKey,initNoDockerCheck,initWorkdir,initNoGitHub,initClientID,initProvider,initNoInput,initRepoURL": "init.go",
	"var:newInitDeps":     "init.go",
	"type:InitPorts":      "init.go",
	"type:InitDeps":       "init.go",
	"func:Validate":       "init.go",
	"var:initCmd":         "init.go",
	"func:init":           "init.go",
	"func:runInitE":       "init.go",
	"func:runInit":        "init.go",
	"func:runInitProbe":   "init.go",
	"func:resolveRepoURL": "init.go",

	"func:gitCloneWorktree":  "init_clone.go",
	"func:removeInitResidue": "init_clone.go",

	"func:runInitAuth":    "init_auth.go",
	"func:runInitAPIKeys": "init_auth.go",
	"func:runInitLegacy":  "init_auth.go",
	"func:promptAPIKey":   "init_auth.go",

	"func:runInitDockerCheck":       "init_scaffold.go",
	"func:runInitScaffold":          "init_scaffold.go",
	"func:gitIgnoreCheaseeSettings": "init_scaffold.go",

	"func:promptConfirm":     "init_prompt.go",
	"func:promptGitIdentity": "init_prompt.go",
	"func:promptInput":       "init_prompt.go",
}

// declKey returns a stable identifier for a top-level declaration.
func declKey(d ast.Decl) string {
	switch dd := d.(type) {
	case *ast.FuncDecl:
		return "func:" + dd.Name.Name
	case *ast.GenDecl:
		if dd.Tok == token.IMPORT {
			return ""
		}
		var names []string
		for _, s := range dd.Specs {
			switch sp := s.(type) {
			case *ast.TypeSpec:
				names = append(names, sp.Name.Name)
			case *ast.ValueSpec:
				for _, n := range sp.Names {
					names = append(names, n.Name)
				}
			}
		}
		return dd.Tok.String() + ":" + strings.Join(names, ",")
	}
	return ""
}

// topLevelDecls parses one file and returns its top-level decl keys.
func topLevelDecls(t *testing.T, file string) []string {
	t.Helper()
	_, keys, err := parseDecls(file)
	if err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}
	return keys
}

// parseDecls parses one file without a testing.T, returning the package name
// and top-level decl keys. Used by the layout checker and its meta-tests.
func parseDecls(path string) (pkg string, keys []string, err error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		return "", nil, err
	}
	for _, d := range f.Decls {
		if k := declKey(d); k != "" {
			keys = append(keys, k)
		}
	}
	return f.Name.Name, keys, nil
}

// TestInitSplitDeclPlacement asserts every inventory decl sits in its target
// file and that the five init*.go files contain nothing outside the inventory.
func TestInitSplitDeclPlacement(t *testing.T) {
	found := map[string]string{} // decl key -> file it was found in
	for _, file := range initSplitFiles {
		for _, key := range topLevelDecls(t, file) {
			if prev, ok := found[key]; ok {
				t.Errorf("decl %q found in both %s and %s", key, prev, file)
				continue
			}
			found[key] = file
		}
	}

	if len(found) != len(wantInitDecls) {
		t.Errorf("found %d top-level decls in init*.go files, inventory has %d", len(found), len(wantInitDecls))
	}

	for key, file := range found {
		wantFile, ok := wantInitDecls[key]
		if !ok {
			t.Errorf("decl %q in %s is not in the split inventory — move it to the planned file", key, file)
			continue
		}
		if file != wantFile {
			t.Errorf("decl %q is in %s, expected %s", key, file, wantFile)
		}
	}
	for key, wantFile := range wantInitDecls {
		if file, ok := found[key]; !ok {
			t.Errorf("inventory decl %q missing from %s", key, wantFile)
		} else if file != wantFile {
			t.Errorf("inventory decl %q in %s, expected %s", key, file, wantFile)
		}
	}
}

// TestInitSplitNoExtraInit asserts func init() lives only in init.go, so flag
// registration keeps its current order (init.go sorts before init_*.go).
func TestInitSplitNoExtraInit(t *testing.T) {
	for _, file := range initSplitFiles {
		for _, key := range topLevelDecls(t, file) {
			if key != "func:init" {
				continue
			}
			if file != "init.go" {
				t.Errorf("func init() found in %s; it must stay in init.go", file)
			}
		}
	}
}

// TestInitSplitFileSize asserts each split file stays under the 500 nbnc
// ceiling (non-blank, non-comment-first lines, matching the audit measure).
func TestInitSplitFileSize(t *testing.T) {
	const ceiling = 500
	for _, file := range initSplitFiles {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		nbnc := 0
		for _, line := range strings.Split(string(data), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed != "" && !strings.HasPrefix(trimmed, "//") {
				nbnc++
			}
		}
		if nbnc >= ceiling {
			t.Errorf("%s has %d non-blank/non-comment lines, ceiling is %d", file, nbnc, ceiling)
		}
	}
}

// ──────────────────────────────────────────────
// Test-file layout invariant + repo-wide size gate
// ──────────────────────────────────────────────

// testSplitFiles are the per-subject test files produced by the init_test.go
// split. New per-subject files must be added here; the checker below reports
// any decl inside them that is not covered by an inventory entry or rule.
var testSplitFiles = []string{
	"init_helpers_test.go",
	"init_clone_test.go",
	"init_usecase_test.go",
	"init_auth_test.go",
	"init_scaffold_test.go",
	"init_prompt_test.go",
}

// initHelperDecls pins the cross-subject helpers to init_helpers_test.go.
// The rest of the original init_test.go helpers moved to helpers_test.go
// (mocks, seam stubs, initDeps) and testutil/ (SetGitConfig,
// RedirectConfigHome, ReadEnvFile, ReadSettingsRaw, CaptureStderr) when main
// consolidated test scaffolding; only the auth helpers remain.
var initHelperDecls = map[string]string{
	"func:authJSONExists": "init_helpers_test.go",
	"func:loadAuthJSON":   "init_helpers_test.go",
}

// runInitFlowDecls pins the TestRunInit_* decls (colliding prefix) by flow
// stage: auth seam, scaffold-only orchestration with mockAuthenticator.
var runInitFlowDecls = map[string]string{
	"func:TestRunInit_FullFlow":                   "init_auth_test.go",
	"func:TestRunInit_NoGitHubFlag":               "init_auth_test.go",
	"func:TestRunInit_ContextCancelledMidFlow":    "init_auth_test.go",
	"func:TestRunInit_GitHubFlowClonesWorktree":   "init_prompt_test.go",
	"func:TestRunInit_NoGitHubLegacySkipsGitInit": "init_prompt_test.go",
}

// testSplitRules map decl name prefixes to their subject file. Rules are
// checked in order; more specific prefixes must come first (e.g.
// TestRunInitScaffold before TestRunInitProbe).
var testSplitRules = []prefixRule{
	{"TestGitCloneWorktree", "init_clone_test.go"},
	{"TestRemoveInitResidue", "init_clone_test.go"},
	{"TestParseGitHubURL", "init_clone_test.go"},
	{"TestRedactToken", "init_clone_test.go"},
	{"TestRunInitAuth", "init_auth_test.go"},
	{"TestRunInitLegacy", "init_auth_test.go"},
	{"TestRunInitScaffold", "init_scaffold_test.go"},
	{"TestGitIgnoreCheaseeSettings", "init_scaffold_test.go"},
	{"TestInitDeps", "init_scaffold_test.go"},
	{"TestInit_SuccessMessage", "init_scaffold_test.go"},
	{"TestInitCmd", "init_prompt_test.go"},
	{"TestInitProbe", "init_usecase_test.go"},
	{"TestInitUseCase", "init_usecase_test.go"},
}

// mergedTestDecls are the decls moved from init_test.go into existing test
// files. The check is one-directional: the moved decls must be present, but
// pre-existing decls in those files are not part of the inventory.
var mergedTestDecls = map[string][]string{
	"config_test.go": {
		"func:TestAuthPerProvider_MarshalHasProviderSlot",
		"func:TestAuthPerProvider_MarshalNoProviderWritesFlat",
		"func:TestAuthPerProvider_MarshalEmptyProviderNoKey",
		"func:TestAuthPerProvider_UnmarshalProviderFormat",
		"func:TestAuthPerProvider_UnmarshalFlatFormat",
		"func:TestAuthPerProvider_SaveWritesJqParseableOutput",
		"func:TestAuthPerProvider_UnmarshalEmptyObject",
		"func:TestAuthPerProvider_UnmarshalMalformedJSON",
		"func:TestAuthPerProvider_RoundTripWithProvider",
		"func:TestAuthPerProvider_MarshalOmitGitHubTokenWhenEmpty",
		"func:TestConfigBackwardCompat_OldAuthLoads",
		"func:TestConfigBackwardCompat_RoundTripPreservesNewFields",
	},
	"embed_test.go": {
		"func:TestExtract_SkipsPiSubtree",
	},
	"template_test.go": {
		"func:TestSettingsScaffold_WritesCorrectContent",
		"func:TestSettingsScaffold_Idempotent",
		"func:TestSettingsScaffold_EmptyValues",
		"func:TestSettingsScaffold_InvalidWorkdir",
		"func:TestSettingsScaffold_ContextCancelled",
	},
}

type prefixRule struct {
	prefix string
	file   string
}

// matchPrefixRule returns the target file of the first rule whose prefix
// matches the decl name, or "" if none match.
func matchPrefixRule(key string, rules []prefixRule) string {
	name := strings.TrimPrefix(key, "func:")
	for _, r := range rules {
		if strings.HasPrefix(name, r.prefix) {
			return r.file
		}
	}
	return ""
}

// checkTestLayout verifies the test-file organization invariants: every decl
// in a subject file is covered by an inventory entry or prefix rule and sits
// in its expected file; every inventory decl exists exactly once; merged-file
// decls are present; every covered file stays package main. Returns a list of
// violations (empty when the layout is clean).
func checkTestLayout(subject []string, want map[string]string, rules []prefixRule, merged map[string][]string) []string {
	var violations []string
	subjectSet := map[string]bool{}
	covered := map[string]bool{}
	for _, f := range subject {
		subjectSet[f] = true
		covered[f] = true
	}
	for f := range merged {
		covered[f] = true
	}

	found := map[string]string{} // decl key -> file it was found in
	byFile := map[string][]string{}
	for f := range covered {
		pkg, keys, err := parseDecls(f)
		if err != nil {
			violations = append(violations, fmt.Sprintf("%s: %v", f, err))
			continue
		}
		if pkg != "main" {
			violations = append(violations, fmt.Sprintf("%s declares package %s; it must stay package main", f, pkg))
		}
		for _, k := range keys {
			if prev, ok := found[k]; ok {
				violations = append(violations, fmt.Sprintf("decl %q found in both %s and %s", k, prev, f))
				continue
			}
			found[k] = f
			byFile[f] = append(byFile[f], k)
		}
	}

	for f, keys := range byFile {
		if !subjectSet[f] {
			continue
		}
		base := filepath.Base(f)
		for _, k := range keys {
			if exp, ok := want[k]; ok {
				if exp != base {
					violations = append(violations, fmt.Sprintf("decl %q is in %s, expected %s", k, base, exp))
				}
				continue
			}
			if ruleFile := matchPrefixRule(k, rules); ruleFile != "" {
				if ruleFile != base {
					violations = append(violations, fmt.Sprintf("decl %q is in %s, expected %s", k, base, ruleFile))
				}
				continue
			}
			violations = append(violations, fmt.Sprintf("decl %q in %s is not covered by the test layout", k, base))
		}
	}

	for k, exp := range want {
		if found[k] == "" {
			violations = append(violations, fmt.Sprintf("inventory decl %q missing from %s", k, exp))
		}
	}

	for f, req := range merged {
		for _, k := range req {
			if filepath.Base(found[k]) != f {
				violations = append(violations, fmt.Sprintf("merged decl %q missing from %s", k, f))
			}
		}
	}
	return violations
}

// TestTestFileLayout asserts the per-subject test files match the split plan.
func TestTestFileLayout(t *testing.T) {
	want := map[string]string{}
	for k, f := range initHelperDecls {
		want[k] = f
	}
	for k, f := range runInitFlowDecls {
		want[k] = f
	}
	for _, v := range checkTestLayout(testSplitFiles, want, testSplitRules, mergedTestDecls) {
		t.Error(v)
	}
}

// TestCheckTestLayoutNegative verifies the layout checker reports misplaced,
// missing, duplicate, uncovered, and non-main-package decls on temp fixtures.
func TestCheckTestLayoutNegative(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		return p
	}

	t.Run("misplaced decl", func(t *testing.T) {
		f := write("misplaced.go", "package main\n\nfunc TestFoo_One(t *testing.T) {}\n")
		v := checkTestLayout([]string{f}, map[string]string{"func:TestFoo_One": "other.go"}, nil, nil)
		if len(v) != 1 || !strings.Contains(v[0], "expected other.go") {
			t.Errorf("expected misplaced-decl violation, got %v", v)
		}
	})

	t.Run("missing decl", func(t *testing.T) {
		f := write("missing.go", "package main\n\nfunc TestBar(t *testing.T) {}\n")
		rules := []prefixRule{{"TestBar", "missing.go"}}
		v := checkTestLayout([]string{f}, map[string]string{"func:TestZed": "missing.go"}, rules, nil)
		if len(v) != 1 || !strings.Contains(v[0], "missing from missing.go") {
			t.Errorf("expected missing-decl violation, got %v", v)
		}
	})

	t.Run("duplicate across files", func(t *testing.T) {
		a := write("dup_a.go", "package main\n\nfunc TestDup(t *testing.T) {}\n")
		b := write("dup_b.go", "package main\n\nfunc TestDup(t *testing.T) {}\n")
		rules := []prefixRule{{"TestDup", "dup_a.go"}}
		v := checkTestLayout([]string{a, b}, nil, rules, nil)
		if len(v) == 0 || !strings.Contains(v[0], "found in both") {
			t.Errorf("expected duplicate-decl violation, got %v", v)
		}
	})

	t.Run("decl outside inventory", func(t *testing.T) {
		f := write("stray.go", "package main\n\nfunc TestStray(t *testing.T) {}\n")
		v := checkTestLayout([]string{f}, nil, nil, nil)
		if len(v) != 1 || !strings.Contains(v[0], "not covered") {
			t.Errorf("expected uncovered-decl violation, got %v", v)
		}
	})

	t.Run("non-main package", func(t *testing.T) {
		f := write("blackbox.go", "package main_test\n\nfunc TestX(t *testing.T) {}\n")
		v := checkTestLayout([]string{f}, nil, nil, nil)
		if len(v) == 0 || !strings.Contains(v[0], "package main_test") {
			t.Errorf("expected package-main violation, got %v", v)
		}
	})
}

// TestDeclKey verifies decl key formats for func/var/type/const decls and that
// import decls yield an empty key.
func TestDeclKey(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want string
	}{
		{"func", "func Foo() {}", "func:Foo"},
		{"var", "var x, y int", "var:x,y"},
		{"type", "type T struct{}", "type:T"},
		{"const", "const a = 1", "const:a"},
		{"import", "import \"fmt\"", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, "x.go", "package main\n"+tc.src, 0)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if got := declKey(f.Decls[0]); got != tc.want {
				t.Errorf("declKey(%s) = %q, want %q", tc.src, got, tc.want)
			}
		})
	}
}

// TestTopLevelDecls verifies topLevelDecls collects func/type/var/const decls
// from a file and skips the import decl.
func TestTopLevelDecls(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "sample.go")
	src := "package main\n\nimport \"fmt\"\n\nfunc A() {}\ntype B struct{}\nvar c int\nconst d = 1\n"
	if err := os.WriteFile(file, []byte(src), 0644); err != nil {
		t.Fatalf("write sample: %v", err)
	}
	got := topLevelDecls(t, file)
	want := []string{"func:A", "type:B", "var:c", "const:d"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("decl %d = %q, want %q", i, got[i], want[i])
		}
	}
}

// ──────────────────────────────────────────────
// Repo-wide 800-line gate (non-blank, non-comment)
// ──────────────────────────────────────────────

// countNBNC returns the number of non-blank, non-comment-first lines, the
// audit measure used by the file-size gates in this file.
func countNBNC(data []byte) int {
	n := 0
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(trimmed, "//") {
			n++
		}
	}
	return n
}

// sizeViolations returns the names of files whose nbnc count is at or above
// ceiling.
func sizeViolations(files []string, ceiling int) []string {
	var over []string
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			over = append(over, f+" (unreadable)")
			continue
		}
		if countNBNC(data) >= ceiling {
			over = append(over, f)
		}
	}
	return over
}

// TestCmdFileSize asserts every .go file in cmd/cheasee-pi stays under the
// 800 nbnc ceiling. Discovery is by glob, so new files are covered
// automatically.
func TestCmdFileSize(t *testing.T) {
	const ceiling = 800
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("no .go files found — glob must discover the package")
	}
	for _, f := range sizeViolations(files, ceiling) {
		t.Errorf("%s has %d non-blank/non-comment lines, ceiling is %d", f, countNBNC(mustRead(t, f)), ceiling)
	}
}

func mustRead(t *testing.T, file string) []byte {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("read %s: %v", file, err)
	}
	return data
}

// TestCountNBNC pins the nbnc counting convention (trim, skip blank, skip
// comment-first lines).
func TestCountNBNC(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want int
	}{
		{"empty", "", 0},
		{"comment only", "// a\n// b\n", 0},
		{"blank and comments", "\n\n// c\n   \n", 0},
		{"mixed", "package main\n\nfunc a() {}\n// comment\n", 2},
	}
	for _, tc := range cases {
		if got := countNBNC([]byte(tc.in)); got != tc.want {
			t.Errorf("%s: countNBNC = %d, want %d", tc.name, got, tc.want)
		}
	}
}

// TestCmdFileSizeBoundary verifies the gate has teeth: 799 nbnc passes,
// 800 and 801 fail.
func TestCmdFileSizeBoundary(t *testing.T) {
	dir := t.TempDir()
	mk := func(name string, nbnc int) string {
		p := filepath.Join(dir, name)
		var b strings.Builder
		b.WriteString("package main\n")
		for i := 0; i < nbnc-1; i++ {
			fmt.Fprintf(&b, "func f%d() {}\n", i)
		}
		if err := os.WriteFile(p, []byte(b.String()), 0644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		return p
	}
	under := mk("under.go", 799)
	at := mk("at.go", 800)
	over := mk("over.go", 801)

	got := sizeViolations([]string{under, at, over}, 800)
	if len(got) != 2 {
		t.Fatalf("expected exactly at.go and over.go over the gate, got %v", got)
	}
	for _, f := range got {
		switch filepath.Base(f) {
		case "at.go", "over.go":
		default:
			t.Errorf("unexpected violation %q", f)
		}
	}
}
