package main

import (
	"bytes"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestCodeFlowServer_TypeScriptExtensionsPure drives the _UI_REWRITES rule
// directly (no HTTP): each of the three upstream classification lists gains
// .mts/.cts directly after its last TypeScript extension, a second pass is a
// byte-identical no-op, and bytes without an anchor are untouched.
func TestCodeFlowServer_TypeScriptExtensionsPure(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	src, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/server.py")
	if err != nil {
		t.Fatalf("read embedded server.py: %v", err)
	}
	dir := t.TempDir()
	serverPath := filepath.Join(dir, "server.py")
	if err := os.WriteFile(serverPath, src, 0644); err != nil {
		t.Fatalf("write server.py: %v", err)
	}
	script := `import runpy, sys

m = runpy.run_path(sys.argv[1])
rewrites = m["_UI_REWRITES"]

def apply(data):
    for pat, repl in rewrites:
        data = pat.sub(lambda _: repl, data)
    return data

code = b"codeExts:['.js','.jsx','.ts','.tsx','.mjs','.cjs','.json'],keep:1"
ts = b"typescript:{grammar:'typescript',exts:['.ts'],coverage:'available'}"
acorn = b"provenance:['.js','.jsx','.ts','.tsx','.mjs','.cjs','.vue','.svelte']"

out = apply(code + b"\n" + ts + b"\n" + acorn)
assert b"codeExts:['.js','.jsx','.ts','.tsx','.mts','.cts','.mjs','.cjs','.json'],keep:1" in out, out
assert b"typescript:{grammar:'typescript',exts:['.ts','.mts','.cts'],coverage:'available'}" in out, out
assert b"provenance:['.js','.jsx','.ts','.tsx','.mts','.cts','.mjs','.cjs','.vue','.svelte']" in out, out
assert out.count(b"'.mts'") == 3, "extension inserted more than once: %r" % out

assert apply(out) == out, "not idempotent"
raw = b"no classification lists present"
assert apply(raw) == raw, "anchor-free bytes altered: %r" % apply(raw)

only_code = apply(code)
assert b"'.tsx','.mts','.cts','.mjs'" in only_code, only_code
only_ts = apply(ts)
assert b"exts:['.ts','.mts','.cts']" in only_ts, only_ts
only_acorn = apply(acorn)
assert only_acorn == b"provenance:['.js','.jsx','.ts','.tsx','.mts','.cts','.mjs','.cjs','.vue','.svelte']", only_acorn
print("OK")
`
	scriptPath := filepath.Join(dir, "check_ts_exts.py")
	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		t.Fatalf("write check script: %v", err)
	}
	out, err := exec.Command(python, scriptPath, serverPath).CombinedOutput()
	if err != nil {
		t.Fatalf("TypeScript-extension rewrite checks failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "OK") {
		t.Fatalf("unexpected helper output: %s", out)
	}
}

// TestCodeFlowServer_TypeScriptExtensionsServed is the serve-path contract:
// index.html gains .mts/.cts in all three classification lists and keeps the
// API-base rewrite, while non-index assets are served verbatim.
func TestCodeFlowServer_TypeScriptExtensionsServed(t *testing.T) {
	anchorish := "codeExts:['.js','.jsx','.ts','.tsx','.mjs','.cjs','.vue','.svelte']"
	uiDir := t.TempDir()
	writeShimFile(t, uiDir, "index.html",
		"<script>'https://api.github.com/'</script>\n"+
			"codeExts:['.js','.jsx','.ts','.tsx','.mjs','.cjs','.json'],x:1\n"+
			"typescript:{grammar:'typescript',exts:['.ts'],coverage:'available'}\n"+
			"provenance:['.js','.jsx','.ts','.tsx','.mjs','.cjs','.vue','.svelte']\n")
	writeShimFile(t, uiDir, filepath.Join("assets", "app.js"), anchorish+"\n")
	base := startShim(t, t.TempDir(), uiDir)

	resp, body := getStatus(t, newNoRedirectClient(), base+"/")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET / status = %d, want 200\nbody: %s", resp.StatusCode, body)
	}
	for _, want := range []string{
		"codeExts:['.js','.jsx','.ts','.tsx','.mts','.cts','.mjs','.cjs','.json'],x:1",
		"typescript:{grammar:'typescript',exts:['.ts','.mts','.cts'],coverage:'available'}",
		"provenance:['.js','.jsx','.ts','.tsx','.mts','.cts','.mjs','.cjs','.vue','.svelte']",
		"'api/'",
	} {
		if !bytes.Contains(body, []byte(want)) {
			t.Errorf("served index.html missing %q\nbody: %s", want, body)
		}
	}

	resp, body = getStatus(t, newNoRedirectClient(), base+"/assets/app.js")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /assets/app.js status = %d, want 200", resp.StatusCode)
	}
	if string(body) != anchorish+"\n" {
		t.Errorf("non-index asset was rewritten: %q", body)
	}
}

// TestCodeFlowServer_TypeScriptExtensionsAbsent pins the silent no-op: an
// index.html without any rewrite anchor is served unchanged apart from the
// API-base rewrite (no crash, no truncation).
func TestCodeFlowServer_TypeScriptExtensionsAbsent(t *testing.T) {
	uiDir := t.TempDir()
	orig := "<script>'https://api.github.com/'</script>\nno classification lists here\n"
	writeShimFile(t, uiDir, "index.html", orig)
	base := startShim(t, t.TempDir(), uiDir)

	resp, body := getStatus(t, newNoRedirectClient(), base+"/")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET / status = %d, want 200", resp.StatusCode)
	}
	want := strings.Replace(orig, "'https://api.github.com/'", "'api/'", 1)
	if string(body) != want {
		t.Errorf("anchor-free index altered:\ngot  %q\nwant %q", body, want)
	}
}
