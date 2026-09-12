package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// entrypointPath is the embedded container entrypoint.
func entrypointPath() string {
	return filepath.Join("embedded", "docker", "entrypoint.sh")
}

// committedSettingsPath is the repo's committed dogfooding settings
// (repo root, sibling of cmd/).
func committedSettingsPath() string {
	return filepath.Join("..", "..", ".pi", "settings.json")
}

// scaffoldSettingsPath is the consumer-repo settings template embedded in the
// CLI cache dir.
func scaffoldSettingsPath() string {
	return filepath.Join("embedded", "pi", "settings.json")
}

func readEntrypoint(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(entrypointPath())
	if err != nil {
		t.Fatalf("read embedded entrypoint.sh: %v", err)
	}
	return string(data)
}

func readCommittedSettings(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(committedSettingsPath())
	if err != nil {
		t.Fatalf("read committed .pi/settings.json: %v", err)
	}
	return string(data)
}

func readScaffoldSettings(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(scaffoldSettingsPath())
	if err != nil {
		t.Fatalf("read embedded/pi/settings.json: %v", err)
	}
	return string(data)
}

// detectionBody slices the body of is_cheasee_pi_repo() out of the entrypoint
// (from the opening brace to the next closing brace at column 0).
func detectionBody(t *testing.T, content string) string {
	t.Helper()
	const open = "is_cheasee_pi_repo() {"
	i := strings.Index(content, open)
	if i < 0 {
		t.Fatal("is_cheasee_pi_repo() not defined")
	}
	body := content[i+len(open):]
	j := strings.Index(body, "\n}")
	if j < 0 {
		t.Fatal("is_cheasee_pi_repo() body not closed")
	}
	return body[:j]
}

// extractFunc pulls the named function definition out of entrypoint.sh (from
// `name() {` to the closing brace at column 0) so behavioral checks execute the
// production function, never a test-side copy (audit: extract-or-execute).
func extractFunc(t *testing.T, name string) string {
	t.Helper()
	content := readEntrypoint(t)
	start := strings.Index(content, name+"() {")
	if start < 0 {
		t.Fatalf("entrypoint must define %s()", name)
	}
	rel := content[start:]
	// Body lines are indented; the definition closes with a bare } at column 0.
	end := strings.Index(rel, "\n}\n")
	if end < 0 {
		t.Fatalf("%s() definition must close with } at column 0", name)
	}
	return rel[:end+len("\n}\n")]
}

// runBashScript feeds a bash program (function text + body) to real bash,
// honoring the audit extract-and-execute convention: the production function
// text is pulled verbatim from entrypoint.sh, never re-typed in the test.
func runBashScript(t *testing.T, script string) (string, error) {
	t.Helper()
	out, err := exec.Command("bash", "-c", script).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// funcScript returns a set -e bash program that defines the extracted
// production function and then runs body.
func funcScript(t *testing.T, name string, body string) string {
	t.Helper()
	return "set -e\n" + extractFunc(t, name) + body
}

// assertOK asserts the extract-and-execute run succeeded and printed OK.
func assertOK(t *testing.T, out string, err error, what string) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s failed: %v (%s)", what, err, out)
	}
	if !strings.Contains(out, "OK") {
		t.Errorf("%s = %q, want OK", what, out)
	}
}

// shq single-quotes s so hostile values reach the extracted function
// literally — the test's own shell must never expand them.
func shq(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// stubBin writes an executable sh stub that appends "<name> $@" to marker
// (plus extra body), so behavioral checks observe remap_uid_gid's external
// calls without root or real usermod/groupmod.
func stubBin(t *testing.T, dir, name, marker, extra string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	content := "#!/bin/sh\necho \"" + name + " $@\" >> '" + marker + "'\n" + extra + "\nexit 0\n"
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write stub %s: %v", name, err)
	}
	return path
}

// remapStubs returns the temp bin dir (prepended to PATH) and the marker file
// path with usermod/groupmod/id stubbed in; id reports 1000 for both -u/-g so
// numeric remap targets are always "different" and proceed.
func remapStubs(t *testing.T) (binDir, marker string) {
	t.Helper()
	binDir = t.TempDir()
	marker = filepath.Join(t.TempDir(), "marker")
	stubBin(t, binDir, "usermod", marker, "")
	stubBin(t, binDir, "groupmod", marker, "")
	idExtra := `case "$1" in
  -u) echo 1000 ;;
  -g) echo 1000 ;;
esac`
	stubBin(t, binDir, "id", marker, idExtra)
	return binDir, marker
}
