package main

import (
	"bytes"
	"encoding/base64"
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

// TestCodeFlowServer_Smoke starts the embedded server against a fake repo
// root and verifies the emulated GitHub API surface still serves: tree
// listing, contents listing/file, repo metadata, and the 404 error path. A
// runtime NameError (e.g. a stray reference to a removed helper) would
// surface as a traceback in the captured server log.
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
	initGitRepo(t, repoRoot)
	gitAddAll(t, repoRoot)
	gitCommit(t, repoRoot)
	// Untracked + EXCLUDE_DIRS junk: cheasee-pi materializes this inside a
	// user workspace and a user repo's .gitignore rarely covers it, so it must
	// never reach the analysis.
	write(filepath.Join(".pi", "git", "github.com", "acme", "lib.js"), []byte("junk\n"))
	write(filepath.Join("node_modules", "pkg", "index.js"), []byte("junk\n"))
	write("untracked.txt", []byte("junk\n"))

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
	if len(blobs) != 2 {
		t.Errorf("trees: served %d blobs, want only the 2 tracked ones: %v", len(blobs), blobs)
	}

	// Contents: dir listing and file body both come from the tracked set, so
	// the untracked junk above is invisible here too.
	status, body = get("/api/repos/o/r/contents")
	if status != http.StatusOK {
		t.Fatalf("contents root: status %d, body %s", status, body)
	}
	var listing []struct {
		Type string `json:"type"`
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(body, &listing); err != nil {
		t.Fatalf("contents root: bad JSON: %v\n%s", err, body)
	}
	got := make(map[string]string, len(listing))
	for _, e := range listing {
		got[e.Name] = e.Type
	}
	if len(got) != 2 || got["a.txt"] != "file" || got["sub"] != "dir" {
		t.Errorf("contents root = %v, want a.txt:file sub:dir", got)
	}

	status, body = get("/api/repos/o/r/contents/a.txt")
	if status != http.StatusOK {
		t.Fatalf("contents file: status %d, body %s", status, body)
	}
	var file struct {
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	if err := json.Unmarshal(body, &file); err != nil {
		t.Fatalf("contents file: bad JSON: %v\n%s", err, body)
	}
	if file.Encoding != "base64" || file.Content != base64.StdEncoding.EncodeToString([]byte("hello\n")) {
		t.Errorf("contents file = %+v, want base64 of %q", file, "hello\n")
	}

	if status, _ := get("/api/repos/o/r/contents/untracked.txt"); status != http.StatusNotFound {
		t.Errorf("contents untracked.txt status = %d, want 404", status)
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

func TestCodeFlowServer_ServesCommittedSnapshot(t *testing.T) {
	repoRoot := t.TempDir()
	writeFile(t, repoRoot, "tracked.txt", "committed version\n")
	initGitRepo(t, repoRoot)
	gitAddAll(t, repoRoot)
	gitCommit(t, repoRoot)

	writeFile(t, repoRoot, "tracked.txt", "local edit\n")
	writeFile(t, repoRoot, "staged.txt", "staged but uncommitted\n")
	gitAddAll(t, repoRoot)
	writeFile(t, repoRoot, "untracked.txt", "untracked\n")
	base := startShim(t, repoRoot, writeUIDir(t))
	client := newNoRedirectClient()

	resp, body := getStatus(t, client, base+"/api/repos/o/r/git/trees/main")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("trees: status %d, body %s", resp.StatusCode, body)
	}
	var tree struct {
		Tree []struct {
			Path string `json:"path"`
		} `json:"tree"`
	}
	if err := json.Unmarshal(body, &tree); err != nil {
		t.Fatalf("trees: bad JSON: %v\n%s", err, body)
	}
	if len(tree.Tree) != 1 || tree.Tree[0].Path != "tracked.txt" {
		t.Fatalf("tree paths = %+v, want only committed tracked.txt", tree.Tree)
	}

	resp, body = getStatus(t, client, base+"/api/repos/o/r/contents/tracked.txt")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("tracked contents: status %d, body %s", resp.StatusCode, body)
	}
	var file struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(body, &file); err != nil {
		t.Fatalf("tracked contents: bad JSON: %v\n%s", err, body)
	}
	decoded, err := base64.StdEncoding.DecodeString(file.Content)
	if err != nil {
		t.Fatalf("decode tracked contents: %v", err)
	}
	if got := string(decoded); got != "committed version\n" {
		t.Errorf("tracked contents = %q, want committed version", got)
	}

	for _, name := range []string{"staged.txt", "untracked.txt"} {
		resp, body = getStatus(t, client, base+"/api/repos/o/r/contents/"+name)
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("contents %s status = %d, want 404: %s", name, resp.StatusCode, body)
		}
	}
}

// TestCodeFlowServer_FingerprintChange pins the committed-tree cache identity:
// working-tree and index edits do not matter until they are committed.
func TestCodeFlowServer_FingerprintChange(t *testing.T) {
	repoRoot := t.TempDir()
	writeFile(t, repoRoot, "a.txt", "hello\n")
	writeFile(t, repoRoot, filepath.Join("sub", "b.txt"), "world\n")
	initGitRepo(t, repoRoot)
	writeFile(t, repoRoot, ".gitignore", "ignored/\n")
	gitAddAll(t, repoRoot)
	gitCommit(t, repoRoot)
	writeFile(t, repoRoot, filepath.Join("ignored", "x.txt"), "one\n")
	writeFile(t, repoRoot, filepath.Join("node_modules", "y.txt"), "one\n")
	base := startShim(t, repoRoot, writeUIDir(t), "FP_TTL=0.05")

	before := freshFingerprint(t, base)
	writeFile(t, repoRoot, "a.txt", "hello world\n")
	writeFile(t, repoRoot, "a.txt", "HELLO WORLD\n")
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(filepath.Join(repoRoot, "a.txt"), future, future); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	waitPastTTL()
	if after := freshFingerprint(t, base); after != before {
		t.Error("fingerprint changed for uncommitted tracked-file edits")
	}
	gitAddAll(t, repoRoot)
	waitPastTTL()
	if after := freshFingerprint(t, base); after != before {
		t.Error("fingerprint changed for staged but uncommitted edits")
	}
	gitCommit(t, repoRoot)
	waitPastTTL()
	changed := freshFingerprint(t, base)
	if changed == before {
		t.Error("fingerprint unchanged after committing tracked-file edits")
	}

	writeFile(t, repoRoot, filepath.Join("sub", "c.txt"), "new\n")
	waitPastTTL()
	if after := freshFingerprint(t, base); after != changed {
		t.Error("fingerprint changed for an untracked new file")
	}
	gitAddAll(t, repoRoot)
	waitPastTTL()
	if after := freshFingerprint(t, base); after != changed {
		t.Error("fingerprint changed for a staged but uncommitted new file")
	}
	gitCommit(t, repoRoot)
	waitPastTTL()
	added := freshFingerprint(t, base)
	if added == changed {
		t.Error("fingerprint unchanged after committing a new file")
	}

	if err := os.Remove(filepath.Join(repoRoot, "sub", "c.txt")); err != nil {
		t.Fatalf("remove: %v", err)
	}
	waitPastTTL()
	if after := freshFingerprint(t, base); after != added {
		t.Error("fingerprint changed for an uncommitted deletion")
	}
	gitAddAll(t, repoRoot)
	waitPastTTL()
	if after := freshFingerprint(t, base); after != added {
		t.Error("fingerprint changed for a staged but uncommitted deletion")
	}
	gitCommit(t, repoRoot)
	waitPastTTL()
	if after := freshFingerprint(t, base); after == added {
		t.Error("fingerprint unchanged after committing a deletion")
	}

	before = freshFingerprint(t, base)
	writeFile(t, repoRoot, filepath.Join("ignored", "x.txt"), "two\n")
	writeFile(t, repoRoot, filepath.Join("node_modules", "y.txt"), "two\n")
	waitPastTTL()
	if after := freshFingerprint(t, base); after != before {
		t.Error("fingerprint changed after editing excluded paths")
	}
}
