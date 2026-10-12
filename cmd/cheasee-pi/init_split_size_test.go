package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
		{"mixed", "package main\n\nfunc alpha() {}\n// comment\n", 2},
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
