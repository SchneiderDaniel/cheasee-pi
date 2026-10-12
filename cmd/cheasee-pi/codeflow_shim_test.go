package main

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestCodeFlowServer_EmbeddedSourceStatic guards the removal-only dead-code
// change: the embedded server.py must no longer contain the dead bool-coercion
// helper, its preserved surface (_load_config, Handler, _walk, inline config
// fallbacks) must be intact, and the file must still compile under python3 —
// mirroring the Dockerfile gate (RUN python3 -m py_compile /opt/codeflow/server.py).
func TestCodeFlowServer_EmbeddedSourceStatic(t *testing.T) {
	src, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/server.py")
	if err != nil {
		t.Fatalf("read embedded server.py: %v", err)
	}
	code := string(src)

	// Name split so a repo-wide literal grep for the removed helper stays clean.
	removed := "_as" + "_bool"
	if strings.Contains(code, removed) {
		t.Error("embedded server.py still contains the dead bool-coercion helper")
	}
	for _, want := range []string{
		"def _load_config",
		"class Handler",
		"def _walk",
		"EXCLUDE_DIRS = set(",
		"PORT = int(",
		"except (TypeError, ValueError):",
		"HOST =",
		// issue #1907: .mts/.cts classification must ship in the embedded source.
		"_TS_EXTS = (",
		"codeExts:['.js','.jsx','.ts','.tsx'",
		"typescript:{grammar:'typescript',exts:['.ts'",
		"['.js','.jsx','.ts','.tsx'",
		",'.mjs','.cjs','.vue','.svelte']",
		// #1935 follow-up: the sidecar runs as root over a host-owned mount, so
		// git needs the safe.directory opt-in or committed-tree listing fails.
		"safe.directory=*",
		// The served set is HEAD's committed tree, not the working tree or index.
		"ls-tree",
		"def _committed_blobs",
		"def _list_contents",
		"def _file_contents",
		// issue #1983: the on-demand headless run route + its seams.
		"/api/analysis/run",
		"/api/analysis/run-status",
		"ANALYZER_CMD",
		"run_timeout_s",
		// issue #1993: a stale embedded source cannot ship without the routes
		// the running image is probed for.
		"/api/analysis/bridge-status",
		"_BRIDGE_STATUS_ROUTE",
		"_RUN_ROUTE",
		"_RUN_STATUS_ROUTE",
	} {
		if !strings.Contains(code, want) {
			t.Errorf("preserved surface missing %q", want)
		}
	}

	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	// Compile a temp copy so __pycache__ stays out of the worktree.
	copyPath := filepath.Join(t.TempDir(), "server.py")
	if err := os.WriteFile(copyPath, src, 0644); err != nil {
		t.Fatalf("write temp server.py: %v", err)
	}
	if out, err := exec.Command(python, "-m", "py_compile", copyPath).CombinedOutput(); err != nil {
		t.Errorf("python3 -m py_compile failed: %v\n%s", err, out)
	}
}

// TestCodeFlowServer_FingerprintPure drives the hashing helper directly (no
// HTTP) to pin its identity semantics: deterministic, order-independent, and
// sensitive to committed paths and blob-object changes.
func TestCodeFlowServer_FingerprintPure(t *testing.T) {
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
	script := `import re, runpy, sys

m = runpy.run_path(sys.argv[1])
fp = m["_fingerprint"]
n = m["_FP_LEN"]

base = [
    {"path": "a.txt", "type": "blob", "size": 6, "oid": "a" * 40},
    {"path": "sub/b.txt", "type": "blob", "size": 9, "oid": "b" * 40},
]
d = fp(base)
assert d == fp(base), "unstable across identical calls"
assert d == fp(list(reversed(base))), "order-dependent"
assert re.fullmatch(r"[0-9a-f]{%d}" % n, d), "bad shape/len: %r" % d


def permute_blobs(fn):
    e = [dict(x) for x in base]
    fn(e)
    return e


for label, fn in [
    ("blob", lambda e: e[0].__setitem__("oid", "c" * 40)),
    ("rename", lambda e: e[0].__setitem__("path", "a2.txt")),
    ("add", lambda e: e.append({"path": "c.txt", "type": "blob", "size": 1, "oid": "c" * 40})),
    ("drop", lambda e: e.pop(0)),
]:
    assert fp(permute_blobs(fn)) != d, "digest unchanged for %s" % label

assert fp([]) == fp([]), "empty digest unstable"
assert re.fullmatch(r"[0-9a-f]{%d}" % n, fp([])), "empty digest shape"
print("OK")
`
	scriptPath := filepath.Join(dir, "check.py")
	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		t.Fatalf("write check.py: %v", err)
	}
	out, err := exec.Command(python, scriptPath, serverPath).CombinedOutput()
	if err != nil {
		t.Fatalf("pure fingerprint checks failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "OK") {
		t.Fatalf("unexpected helper output: %s", out)
	}
}

// TestCodeFlowServer_ScanCacheSlowWorkspace guards the cache-expiry fix: when
// traversal plus ignore filtering takes longer than the TTL, the stored expiry
// must be measured after the scan so a slow workspace still shares one scan
// between the entrypoint redirect and the subsequent tree request.
func TestCodeFlowServer_ScanCacheSlowWorkspace(t *testing.T) {
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
	repoRoot := t.TempDir()
	writeShimFile(t, repoRoot, "a.txt", "hello\n")
	initGitRepo(t, repoRoot)
	gitAddAll(t, repoRoot)

	// A scan slower than the TTL must still be reused by the next call. Note
	// runpy.run_path returns a globals copy; functions keep the original dict,
	// so patch the module globals the helper actually reads.
	script := `import runpy, sys, time

m = runpy.run_path(sys.argv[1])
g = m["_scan"].__globals__
g["REPO_ROOT"] = sys.argv[2]
g["_FP_TTL"] = 0.3
g["_scan_cache"] = None

real = g["_committed_blobs"]
calls = {"n": 0}


def slow():
    calls["n"] += 1
    time.sleep(0.5)  # scan exceeds the TTL
    return real()


g["_committed_blobs"] = slow
scan = m["_scan"]

first = scan()
second = scan()
assert calls["n"] == 1, "scan not shared across calls: %d traversals" % calls["n"]
assert first == second, "cached entries differ"
print("OK")
`
	scriptPath := filepath.Join(dir, "check_slow.py")
	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		t.Fatalf("write check_slow.py: %v", err)
	}
	out, err := exec.Command(python, scriptPath, serverPath, repoRoot).CombinedOutput()
	if err != nil {
		t.Fatalf("slow-scan cache check failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "OK") {
		t.Fatalf("unexpected helper output: %s", out)
	}
}
