package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
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

// --- Shared harness for the fingerprint / redirect tests ------------------

var fpRepoRE = regexp.MustCompile(`^local/workspace-([0-9a-f]{8})$`)

func writeFile(t *testing.T, root, rel, content string) {
	t.Helper()
	path := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}

// initGitRepo makes root a git work tree: the shim serves HEAD's committed
// tree, so every API test needs a commit. Skips when git is unavailable.
func initGitRepo(t *testing.T, root string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	if out, err := exec.Command("git", "-C", root, "init", "-q").CombinedOutput(); err != nil {
		t.Skipf("git init failed: %v\n%s", err, out)
	}
}

// gitAddAll stages every fixture file.
func gitAddAll(t *testing.T, root string) {
	t.Helper()
	if out, err := exec.Command("git", "-C", root, "add", "-A").CombinedOutput(); err != nil {
		t.Fatalf("git add -A: %v\n%s", err, out)
	}
}

func gitCommit(t *testing.T, root string) {
	t.Helper()
	cmd := exec.Command("git", "-C", root, "-c", "user.name=CodeFlow Test", "-c", "user.email=codeflow@example.invalid", "commit", "-qm", "fixture snapshot")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v\n%s", err, out)
	}
}

// writeUIDir creates the dummy UI checkout the shim serves (index.html plus a
// static asset) so entrypoint and static paths are both exercisable.
func writeUIDir(t *testing.T) string {
	t.Helper()
	uiDir := t.TempDir()
	writeFile(t, uiDir, "index.html", "<script>'https://api.github.com/'</script>")
	writeFile(t, uiDir, filepath.Join("assets", "app.js"), "console.log(1)\n")
	return uiDir
}

// startShim boots the embedded server.py against repoRoot/uiDir on a free port
// and returns its base URL. The process is killed and its log checked for a
// traceback at cleanup. extraEnv overrides/extends the server environment.
func startShim(t *testing.T, repoRoot, uiDir string, extraEnv ...string) string {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	src, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/server.py")
	if err != nil {
		t.Fatalf("read embedded server.py: %v", err)
	}
	serverPath := filepath.Join(t.TempDir(), "server.py")
	if err := os.WriteFile(serverPath, src, 0644); err != nil {
		t.Fatalf("write server.py: %v", err)
	}
	// The shim serves /fp-filter.js from its own directory; the container gets
	// the file from the Dockerfile COPY, so the harness must place it too.
	filterSrc, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/fp-filter.js")
	if err != nil {
		t.Fatalf("read embedded fp-filter.js: %v", err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(serverPath), "fp-filter.js"), filterSrc, 0644); err != nil {
		t.Fatalf("write fp-filter.js: %v", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	cmd := exec.Command(python, serverPath)
	cmd.Env = append(os.Environ(),
		"REPO_ROOT="+repoRoot,
		"UI_DIR="+uiDir,
		"CONFIG_FILE="+filepath.Join(t.TempDir(), "missing-config.json"),
		fmt.Sprintf("PORT=%d", port),
		"HOST=127.0.0.1",
		"PYTHONUNBUFFERED=1",
	)
	cmd.Env = append(cmd.Env, extraEnv...)
	var log bytes.Buffer
	cmd.Stdout = &log
	cmd.Stderr = &log
	if err := cmd.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		select {
		case <-done: // SIGKILL is the expected shutdown path (serve_forever)
		case <-time.After(5 * time.Second):
			t.Error("server process did not exit after Kill")
		}
		if strings.Contains(log.String(), "Traceback") {
			t.Errorf("server log contains a traceback:\n%s", log.String())
		}
	})

	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	client := &http.Client{Timeout: 5 * time.Second}
	deadline := time.Now().Add(15 * time.Second)
	for {
		select {
		case <-done:
			t.Fatalf("server exited early:\n%s", log.String())
		default:
		}
		r, err := client.Get(base + "/api/repos/o/r")
		if err == nil {
			r.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("server did not come up: %v\nlog:\n%s", err, log.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
	return base
}

// newNoRedirectClient returns a client that surfaces 3xx responses verbatim
// instead of following them, so redirect contracts are directly assertable.
func newNoRedirectClient() *http.Client {
	return &http.Client{
		Timeout: 5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func getStatus(t *testing.T, client *http.Client, rawURL string) (*http.Response, []byte) {
	t.Helper()
	resp, err := client.Get(rawURL)
	if err != nil {
		t.Fatalf("GET %s: %v", rawURL, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read GET %s body: %v", rawURL, err)
	}
	return resp, body
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse url %q: %v", raw, err)
	}
	return u
}

// freshFingerprint opens the stable entrypoint and returns the fingerprint the
// shim appends to the repo segment (always a redirect: no suffix is sent).
func freshFingerprint(t *testing.T, base string) string {
	t.Helper()
	resp, body := getStatus(t, newNoRedirectClient(), base+"/?repo=local/workspace&run=1")
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("entrypoint status = %d, want 302\nbody: %s", resp.StatusCode, body)
	}
	m := fpRepoRE.FindStringSubmatch(mustURL(t, resp.Header.Get("Location")).Query().Get("repo"))
	if m == nil {
		t.Fatalf("repo %q is not fingerprinted", resp.Header.Get("Location"))
	}
	return m[1]
}

// waitPastTTL sleeps past the FP_TTL=0.05 override so the next request rescans.
func waitPastTTL() { time.Sleep(300 * time.Millisecond) }

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


def variant(fn):
    e = [dict(x) for x in base]
    fn(e)
    return e


for label, fn in [
    ("blob", lambda e: e[0].__setitem__("oid", "c" * 40)),
    ("rename", lambda e: e[0].__setitem__("path", "a2.txt")),
    ("add", lambda e: e.append({"path": "c.txt", "type": "blob", "size": 1, "oid": "c" * 40})),
    ("drop", lambda e: e.pop(0)),
]:
    assert fp(variant(fn)) != d, "digest unchanged for %s" % label

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
	writeFile(t, repoRoot, "a.txt", "hello\n")
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

// TestCodeFlowServer_EntrypointRedirect pins the redirect contract: only the
// entrypoint with a repo param redirects, and every other param survives.
func TestCodeFlowServer_EntrypointRedirect(t *testing.T) {
	repoRoot := t.TempDir()
	writeFile(t, repoRoot, "a.txt", "hello\n")
	writeFile(t, repoRoot, filepath.Join("sub", "b.txt"), "world\n")
	initGitRepo(t, repoRoot)
	gitAddAll(t, repoRoot)
	gitCommit(t, repoRoot)
	base := startShim(t, repoRoot, writeUIDir(t))
	client := newNoRedirectClient()

	resp, body := getStatus(t, client, base+"/?repo=local/workspace&run=1")
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("entrypoint status = %d, want 302\nbody: %s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	loc := resp.Header.Get("Location")
	if !strings.HasPrefix(loc, "/") || strings.Contains(loc, "://") {
		t.Errorf("Location %q must be relative and start with /", loc)
	}
	u := mustURL(t, loc)
	if u.Path != "/" {
		t.Errorf("Location path = %q, want /", u.Path)
	}
	if !fpRepoRE.MatchString(u.Query().Get("repo")) {
		t.Errorf("repo = %q, want ^local/workspace-[0-9a-f]{8}$", u.Query().Get("repo"))
	}
	if u.Query().Get("run") != "1" {
		t.Errorf("run = %q, want 1", u.Query().Get("run"))
	}

	resp, _ = getStatus(t, client, base+"/index.html?repo=local/workspace")
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("/index.html status = %d, want 302", resp.StatusCode)
	}
	if p := mustURL(t, resp.Header.Get("Location")).Path; p != "/index.html" {
		t.Errorf("/index.html Location path = %q, want /index.html", p)
	}

	resp, _ = getStatus(t, client, base+"/?repo=local/workspace&theme=dark&run=1")
	q := mustURL(t, resp.Header.Get("Location")).Query()
	if q.Get("theme") != "dark" || q.Get("run") != "1" {
		t.Errorf("redirect dropped params: %v", q)
	}

	// URL-encoded repo decodes to the base and gains exactly one suffix.
	resp, _ = getStatus(t, client, base+"/?repo=local%2Fworkspace")
	if repo := mustURL(t, resp.Header.Get("Location")).Query().Get("repo"); !fpRepoRE.MatchString(repo) {
		t.Errorf("encoded repo = %q, want fingerprinted", repo)
	}

	// CRLF in repo must not reach the header raw.
	resp, _ = getStatus(t, client, base+"/index.html?repo=local%0d%0aworkspace")
	if loc := resp.Header.Get("Location"); strings.ContainsAny(loc, "\r\n") {
		t.Errorf("Location contains raw CRLF: %q", loc)
	}

	// No repo → plain 200 entrypoint.
	if resp, _ := getStatus(t, client, base+"/"); resp.StatusCode != http.StatusOK {
		t.Errorf("no-repo entrypoint status = %d, want 200", resp.StatusCode)
	}

	// Static assets and API paths never redirect.
	if resp, _ := getStatus(t, client, base+"/assets/app.js?repo=local/workspace"); resp.StatusCode != http.StatusOK {
		t.Errorf("/assets status = %d, want 200", resp.StatusCode)
	}
	if resp, _ := getStatus(t, client, base+"/api/repos/o/r?repo=local/workspace"); resp.StatusCode != http.StatusOK {
		t.Errorf("repo API status = %d, want 200", resp.StatusCode)
	}
	resp, body = getStatus(t, client, base+"/api/repos/o/r/git/trees/main?repo=local/workspace")
	if resp.StatusCode != http.StatusOK {
		t.Errorf("tree API status = %d, want 200", resp.StatusCode)
	}
	var tree struct {
		Tree []map[string]json.RawMessage `json:"tree"`
	}
	if err := json.Unmarshal(body, &tree); err != nil {
		t.Fatalf("tree JSON: %v\n%s", err, body)
	}
	for _, e := range tree.Tree {
		for k := range e {
			if k != "path" && k != "type" && k != "size" {
				t.Errorf("tree blob has unexpected key %q: %v", k, e)
			}
		}
	}
}

// TestCodeFlowServer_EntrypointRedirectIdempotent pins loop-freedom: the
// redirected URL serves, and a stale/extra suffix resolves to a single current
// fingerprint without double-suffixing.
func TestCodeFlowServer_EntrypointRedirectIdempotent(t *testing.T) {
	repoRoot := t.TempDir()
	writeFile(t, repoRoot, "a.txt", "hello\n")
	initGitRepo(t, repoRoot)
	gitAddAll(t, repoRoot)
	gitCommit(t, repoRoot)
	base := startShim(t, repoRoot, writeUIDir(t))
	client := newNoRedirectClient()

	resp, _ := getStatus(t, client, base+"/?repo=local/workspace&run=1")
	loc := resp.Header.Get("Location")
	fp := fpRepoRE.FindStringSubmatch(mustURL(t, loc).Query().Get("repo"))[1]

	if r, _ := getStatus(t, client, base+loc); r.StatusCode != http.StatusOK {
		t.Errorf("followed redirect status = %d, want 200", r.StatusCode)
	}
	if r, _ := getStatus(t, client, base+"/?repo=local/workspace-"+fp); r.StatusCode != http.StatusOK {
		t.Errorf("current-fingerprint status = %d, want 200", r.StatusCode)
	}

	resp, _ = getStatus(t, client, base+"/?repo=local/workspace-deadbeef")
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("stale-fingerprint status = %d, want 302", resp.StatusCode)
	}
	if got := mustURL(t, resp.Header.Get("Location")).Query().Get("repo"); got != "local/workspace-"+fp {
		t.Errorf("stale-fingerprint repo = %q, want local/workspace-%s", got, fp)
	}

	// Only the trailing -hex suffix is stripped from a longer base.
	resp, _ = getStatus(t, client, base+"/?repo=local/my-repo-12345678")
	got := mustURL(t, resp.Header.Get("Location")).Query().Get("repo")
	if resp.StatusCode != http.StatusFound || got != "local/my-repo-"+fp {
		t.Errorf("long-base repo = %q (status %d), want local/my-repo-%s", got, resp.StatusCode, fp)
	}
}

// TestCodeFlowServer_ConcurrentEntrypoints exercises the shared module-level
// scan cache under ThreadingHTTPServer: every response is a valid 302/200 and
// the captured log stays traceback-free.
func TestCodeFlowServer_ConcurrentEntrypoints(t *testing.T) {
	repoRoot := t.TempDir()
	writeFile(t, repoRoot, "a.txt", "hello\n")
	initGitRepo(t, repoRoot)
	gitAddAll(t, repoRoot)
	gitCommit(t, repoRoot)
	base := startShim(t, repoRoot, writeUIDir(t), "FP_TTL=0.05")

	var wg sync.WaitGroup
	errs := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := newNoRedirectClient().Get(base + "/?repo=local/workspace&run=1")
			if err != nil {
				errs <- err.Error()
				return
			}
			defer resp.Body.Close()
			_, _ = io.Copy(io.Discard, resp.Body)
			if resp.StatusCode != http.StatusFound && resp.StatusCode != http.StatusOK {
				errs <- fmt.Sprintf("status %d", resp.StatusCode)
				return
			}
			if resp.StatusCode == http.StatusFound && resp.Header.Get("Location") == "" {
				errs <- "302 without Location"
			}
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}
}

// TestCodeFlowServer_GitUnavailableWarns pins the fail-closed behaviour: when
// the git index cannot be listed (REPO_ROOT is not a work tree / git missing),
// the shim serves nothing and emits a one-shot stderr warning instead of
// falling back to a full working-tree walk — which is exactly how untracked
// cheasee-pi artifacts leaked into the analysis.
func TestCodeFlowServer_GitUnavailableWarns(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
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
	nonGit := t.TempDir()
	script := `import contextlib, io, runpy, sys

m = runpy.run_path(sys.argv[1])
g = m["_scan"].__globals__
g["REPO_ROOT"] = sys.argv[2]
g["_GIT_WARNED"] = False
buf = io.StringIO()
with contextlib.redirect_stderr(buf):
    out = g["_committed_blobs"]()
assert out is None, out
first = buf.getvalue()
assert "committed tree unavailable" in first, first
assert sys.argv[2] in first, first
assert "not a git repository" in first, first
# One-shot: a second call stays quiet.
buf2 = io.StringIO()
with contextlib.redirect_stderr(buf2):
    g["_committed_blobs"]()
assert buf2.getvalue() == "", buf2.getvalue()
print("OK")
`
	scriptPath := filepath.Join(dir, "check_git_warn.py")
	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		t.Fatalf("write check script: %v", err)
	}
	out, err := exec.Command(python, scriptPath, serverPath, nonGit).CombinedOutput()
	if err != nil {
		t.Fatalf("git-unavailable warning checks failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "OK") {
		t.Fatalf("unexpected helper output: %s", out)
	}
}

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
	writeFile(t, uiDir, "index.html",
		"<script>'https://api.github.com/'</script>\n"+
			"codeExts:['.js','.jsx','.ts','.tsx','.mjs','.cjs','.json'],x:1\n"+
			"typescript:{grammar:'typescript',exts:['.ts'],coverage:'available'}\n"+
			"provenance:['.js','.jsx','.ts','.tsx','.mjs','.cjs','.vue','.svelte']\n")
	writeFile(t, uiDir, filepath.Join("assets", "app.js"), anchorish+"\n")
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
	writeFile(t, uiDir, "index.html", orig)
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

// TestCodeFlowServer_FpFilterRewritePure drives the browser-parity rewrite for
// the false-positive filter directly (no HTTP): the page's own generateReport is
// wrapped in the same filter the headless runner applies, a second pass is a
// byte-identical no-op, and bytes without the anchor are untouched.
func TestCodeFlowServer_FpFilterRewritePure(t *testing.T) {
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
	script := `import runpy, sys, os

m = runpy.run_path(sys.argv[1])
pat, repl = m["_UI_REWRITES"][0]

src = b"<script>function generateReport(format){return format;}</script>"
out = pat.sub(lambda _: repl, src)
assert out.count(b"function __piFpGenerateReport(format){return format;}") == 1, out
assert out.count(b"piFpFilter.sanitizeAnalysisData(data, piFpFilter.readFileFrom(data))") == 1, out
assert b'if ("securityIssues" in __piFp.data) data.securityIssues = __piFp.data.securityIssues;' in out, out
assert b'if ("layerViolations" in __piFp.data) data.layerViolations = __piFp.data.layerViolations;' in out, out
assert b"data = piFpFilter" not in out, "must not rebind data (const-safe): %r" % out
assert b'"use strict"' in out, out
assert b"throw e" in out, "sanitizer error must fail closed: %r" % out
assert b"__codeflowBridgeReportError" in out, "sanitizer failure must be visible: %r" % out
assert b"window.__codeflowBridgeReportError = reportError" in m["_BRIDGE_JS"], m["_BRIDGE_JS"]
assert b"return __piFpGenerateReport.apply(this, arguments)" in out, out
assert pat.sub(lambda _: repl, out) == out, "not idempotent"

raw = b"<script>no report function here</script>"
assert pat.sub(lambda _: repl, raw) == raw, "anchor-free bytes altered: %r" % pat.sub(lambda _: repl, raw)

bridge = m["_BRIDGE_SCRIPT"]
assert bridge.count(b"fp-filter.js") == 1, bridge
assert bridge.count(b"codeflow-bridge.js") == 1, bridge
assert m["_FP_FILTER_ROUTE"] == "/fp-filter.js"
assert os.path.basename(m["_FP_FILTER_PATH"]) == "fp-filter.js"
print("OK")
`
	scriptPath := filepath.Join(dir, "check_fp_filter.py")
	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		t.Fatalf("write check script: %v", err)
	}
	out, err := exec.Command(python, scriptPath, serverPath).CombinedOutput()
	if err != nil {
		t.Fatalf("false-positive wrapper checks failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "OK") {
		t.Fatalf("unexpected helper output: %s", out)
	}
}

// TestCodeFlowServer_FpFilterWrapperBehavior executes the served-page wrapper:
// the page declares `data` as a constant, so the old rebinding threw and fell
// back to the unfiltered report. The wrapper must filter by overwriting the
// array properties, and a sanitizer error must fail closed (no unfiltered
// export). The rewritten generateReport comes from the real server.py rewrite.
func TestCodeFlowServer_FpFilterWrapperBehavior(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not available")
	}
	serverSrc, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/server.py")
	if err != nil {
		t.Fatalf("read embedded server.py: %v", err)
	}
	filterSrc, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/fp-filter.js")
	if err != nil {
		t.Fatalf("read embedded fp-filter.js: %v", err)
	}
	dir := t.TempDir()
	serverPath := filepath.Join(dir, "server.py")
	filterPath := filepath.Join(dir, "fp-filter.js")
	if err := os.WriteFile(serverPath, serverSrc, 0644); err != nil {
		t.Fatalf("write server.py: %v", err)
	}
	if err := os.WriteFile(filterPath, filterSrc, 0644); err != nil {
		t.Fatalf("write fp-filter.js: %v", err)
	}

	// Emit two CommonJS harnesses: one with a real `const data`, one whose
	// sanitizer throws. Both inline the rewrite server.py actually serves.
	script := `import runpy, sys

m = runpy.run_path(sys.argv[1])
pat, repl = m["_UI_REWRITES"][0]
rewritten = pat.sub(lambda _: repl, b"function generateReport(format){ return data; }").decode()

ok = """const data = { securityIssues: [ { severity: 'high', title: 'Hardcoded Secret', code: '', path: 'x.ts' } ], layerViolations: [] };
const piFpFilter = require(process.argv[2]);
""" + rewritten + """
generateReport('md');
process.stdout.write('RESULT' + JSON.stringify({ security: data.securityIssues.length, layers: data.layerViolations.length }));
"""
open(sys.argv[3], "w").write(ok)

fail = """const data = { securityIssues: [] };
globalThis.__bridgeSaw = null;
globalThis.__codeflowBridgeReportError = function (m) { globalThis.__bridgeSaw = m; };
const piFpFilter = { sanitizeAnalysisData() { throw new Error('fp-filter exploded'); }, readFileFrom() { return () => null; } };
""" + rewritten + """
try { generateReport('md'); process.stdout.write('RESULTNO_THROW'); }
catch (e) { process.stdout.write('RESULTTHREW:' + e.message + ':' + globalThis.__codeflowFpFilterError + ':' + globalThis.__bridgeSaw); }
"""
open(sys.argv[4], "w").write(fail)
`
	scriptPath := filepath.Join(dir, "emit_harness.py")
	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		t.Fatalf("write emit script: %v", err)
	}
	okHarness := filepath.Join(dir, "ok.cjs")
	failHarness := filepath.Join(dir, "fail.cjs")
	if out, err := exec.Command(python, scriptPath, serverPath, filterPath, okHarness, failHarness).CombinedOutput(); err != nil {
		t.Fatalf("emit harnesses: %v\n%s", err, out)
	}

	out, err := exec.Command(node, okHarness, filterPath).CombinedOutput()
	if err != nil {
		t.Fatalf("const-data harness failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "RESULT{\"security\":0,\"layers\":0}") {
		t.Errorf("const `data` was not filtered in place: %s", out)
	}

	out, err = exec.Command(node, failHarness, filterPath).CombinedOutput()
	if err != nil {
		t.Fatalf("fail-closed harness failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "RESULTTHREW:fp-filter exploded:fp-filter exploded:false-positive filter failed; report not exported: fp-filter exploded") {
		t.Errorf("sanitizer error must fail closed and surface the failure, got: %s", out)
	}
}

// TestCodeFlowServer_FpFilterServed is the serve-path contract: /fp-filter.js is
// served byte-verbatim as JavaScript, the served index.html references it exactly
// once next to the bridge and wraps generateReport in it.
func TestCodeFlowServer_FpFilterServed(t *testing.T) {
	uiDir := t.TempDir()
	writeFile(t, uiDir, "index.html",
		"<script>function generateReport(format){return format;}</script>\n</body>")
	base := startShim(t, t.TempDir(), uiDir)

	resp, body := getStatus(t, newNoRedirectClient(), base+"/fp-filter.js")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /fp-filter.js status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Errorf("fp-filter.js Content-Type = %q, want text/javascript", ct)
	}
	want, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/fp-filter.js")
	if err != nil {
		t.Fatalf("read embedded fp-filter.js: %v", err)
	}
	if !bytes.Equal(body, want) {
		t.Errorf("served /fp-filter.js is not byte-verbatim (%d want %d bytes)", len(body), len(want))
	}

	resp, body = getStatus(t, newNoRedirectClient(), base+"/")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET / status = %d, want 200\nbody: %s", resp.StatusCode, body)
	}
	for _, want := range []string{
		"<script src=\"fp-filter.js\" defer></script><script src=\"codeflow-bridge.js\" defer></script>",
		"if (\"securityIssues\" in __piFp.data) data.securityIssues = __piFp.data.securityIssues;",
		"if (\"layerViolations\" in __piFp.data) data.layerViolations = __piFp.data.layerViolations;",
		"function __piFpGenerateReport(format){return format;}",
	} {
		if n := bytes.Count(body, []byte(want)); n != 1 {
			t.Errorf("served index.html must contain %q exactly once, got %d\nbody: %s", want, n, body)
		}
	}
}
