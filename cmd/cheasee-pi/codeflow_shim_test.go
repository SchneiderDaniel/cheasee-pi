package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

// TestCodeFlowServer_Smoke starts the embedded server against a fake repo
// root and verifies the emulated GitHub API surface still serves: tree
// listing, repo metadata, and the 404 error path. A runtime NameError (e.g. a
// stray reference to the removed helper) would surface as a traceback in
// the captured server log.
func TestCodeFlowServer_Smoke(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}

	// Fake repo: flat file + nested dir.
	repoRoot := t.TempDir()
	write := func(rel string, data []byte) {
		t.Helper()
		path := filepath.Join(repoRoot, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
		}
		if err := os.WriteFile(path, data, 0644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	write("a.txt", []byte("hello\n"))
	write(filepath.Join("sub", "b.txt"), []byte("world\n"))

	// Reserve a free port, release it, and hand it to the server.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	serverPath := filepath.Join(t.TempDir(), "server.py")
	src, err := fs.ReadFile(embeddedFS, "embedded/docker/codeflow/server.py")
	if err != nil {
		t.Fatalf("read embedded server.py: %v", err)
	}
	if err := os.WriteFile(serverPath, src, 0644); err != nil {
		t.Fatalf("write server.py: %v", err)
	}

	cmd := exec.Command(python, serverPath)
	cmd.Env = append(os.Environ(),
		"REPO_ROOT="+repoRoot,
		"UI_DIR="+t.TempDir(), // empty UI dir; API surface unaffected
		"CONFIG_FILE="+filepath.Join(t.TempDir(), "missing-config.json"),
		fmt.Sprintf("PORT=%d", port),
		"HOST=127.0.0.1",
		"PYTHONUNBUFFERED=1",
	)
	var log bytes.Buffer
	cmd.Stdout = &log
	cmd.Stderr = &log
	if err := cmd.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	defer func() {
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
	}()

	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	client := &http.Client{Timeout: 5 * time.Second}

	// Wait for the server to accept connections.
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

	get := func(path string) (int, []byte) {
		t.Helper()
		r, err := client.Get(base + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		defer r.Body.Close()
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read GET %s body: %v", path, err)
		}
		return r.StatusCode, b
	}

	// Tree listing: both blobs present with correct sizes.
	status, body := get("/api/repos/o/r/git/trees/main")
	if status != http.StatusOK {
		t.Fatalf("trees: status %d, body %s", status, body)
	}
	var tree struct {
		Tree []struct {
			Path string `json:"path"`
			Type string `json:"type"`
			Size int64  `json:"size"`
		} `json:"tree"`
		Truncated bool `json:"truncated"`
	}
	if err := json.Unmarshal(body, &tree); err != nil {
		t.Fatalf("trees: bad JSON: %v\n%s", err, body)
	}
	if tree.Truncated {
		t.Error("trees: unexpected truncated=true")
	}
	blobs := make(map[string]int64)
	for _, e := range tree.Tree {
		if e.Type == "blob" {
			blobs[e.Path] = e.Size
		}
	}
	if blobs["a.txt"] != 6 {
		t.Errorf("trees: a.txt size = %d, want 6 (blobs: %v)", blobs["a.txt"], blobs)
	}
	if blobs["sub/b.txt"] != 6 {
		t.Errorf("trees: sub/b.txt size = %d, want 6 (blobs: %v)", blobs["sub/b.txt"], blobs)
	}

	// Repo metadata.
	status, body = get("/api/repos/o/r")
	if status != http.StatusOK {
		t.Fatalf("repo metadata: status %d, body %s", status, body)
	}
	var meta struct {
		DefaultBranch string `json:"default_branch"`
	}
	if err := json.Unmarshal(body, &meta); err != nil {
		t.Fatalf("repo metadata: bad JSON: %v\n%s", err, body)
	}
	if meta.DefaultBranch != "main" {
		t.Errorf("repo metadata: default_branch = %q, want %q", meta.DefaultBranch, "main")
	}

	// Error path.
	if status, _ := get("/api/nope"); status != http.StatusNotFound {
		t.Errorf("/api/nope status = %d, want 404", status)
	}
}