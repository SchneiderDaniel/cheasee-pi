package main

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
	src := "package main\n\nimport \"fmt\"\n\nfunc AThing() {}\ntype B struct{}\nvar c int\nconst d = 1\n"
	if err := os.WriteFile(file, []byte(src), 0644); err != nil {
		t.Fatalf("write sample: %v", err)
	}
	got := topLevelDecls(t, file)
	want := []string{"func:AThing", "type:B", "var:c", "const:d"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("decl %d = %q, want %q", i, got[i], want[i])
		}
	}
}
