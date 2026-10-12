package main

import (
	"bytes"
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
	"testing"
	"time"
)

// --- Shared harness for the fingerprint / redirect tests ------------------

var fpRepoRE = regexp.MustCompile(`^local/workspace-([0-9a-f]{8})$`)

func writeShimFile(t *testing.T, root, rel, content string) {
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
	writeShimFile(t, uiDir, "index.html", "<script>'https://api.github.com/'</script>")
	writeShimFile(t, uiDir, filepath.Join("assets", "app.js"), "console.log(1)\n")
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
