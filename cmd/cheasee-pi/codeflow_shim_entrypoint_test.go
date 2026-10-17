package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// TestCodeFlowServer_EntrypointRedirect pins the redirect contract: only the
// entrypoint with a repo param redirects, and every other param survives.
func TestCodeFlowServer_EntrypointRedirect(t *testing.T) {
	repoRoot := t.TempDir()
	writeShimFile(t, repoRoot, "a.txt", "hello\n")
	writeShimFile(t, repoRoot, filepath.Join("sub", "b.txt"), "world\n")
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
	writeShimFile(t, repoRoot, "a.txt", "hello\n")
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
	writeShimFile(t, repoRoot, "a.txt", "hello\n")
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
	dir := t.TempDir()
	copyCodeflowDir(t, dir)
	serverPath := filepath.Join(dir, "server.py")
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
