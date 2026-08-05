package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
)

// testGitHubClient creates an httpGitHubClient pointed at the given test server.
func testGitHubClient(ts *httptest.Server) *httpGitHubClient {
	return &httpGitHubClient{
		httpClient: ts.Client(),
		baseURL:    ts.URL,
	}
}

// ──────────────────────────────────────────────
// httpGitHubClient adapter tests
// ──────────────────────────────────────────────

func TestHTTPGitHubClient_GetAuthenticatedUser_200(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/user" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer "+FakeGitHubToken {
			t.Errorf("expected Bearer token, got: %s", r.Header.Get("Authorization"))
		}
		if r.Header.Get("Accept") != "application/vnd.github.v3+json" {
			t.Errorf("expected v3 accept header, got: %s", r.Header.Get("Accept"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"login": "testuser"})
	}))
	defer ts.Close()

	client := testGitHubClient(ts)
	user, err := client.GetAuthenticatedUser(context.Background(), FakeGitHubToken)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if user != "testuser" {
		t.Errorf("expected 'testuser', got %q", user)
	}
}

func TestHTTPGitHubClient_GetAuthenticatedUser_401(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer ts.Close()

	client := testGitHubClient(ts)
	_, err := client.GetAuthenticatedUser(context.Background(), FakeGitHubToken)
	if err == nil {
		t.Fatal("expected error for 401")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("error should mention 401: %v", err)
	}
}

func TestHTTPGitHubClient_CreateFork_202(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if !strings.HasSuffix(r.URL.Path, "/repos/owner/repo/forks") {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusAccepted)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"owner": map[string]string{"login": "forkuser"},
			"name":  "repo",
		})
	}))
	defer ts.Close()

	client := testGitHubClient(ts)
	fork, err := client.CreateFork(context.Background(), FakeGitHubToken, "owner", "repo")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fork != "forkuser/repo" {
		t.Errorf("expected 'forkuser/repo', got %q", fork)
	}
}

func TestHTTPGitHubClient_CreateFork_422(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"message":"fork already exists"}`)
	}))
	defer ts.Close()

	client := testGitHubClient(ts)
	_, err := client.CreateFork(context.Background(), FakeGitHubToken, "owner", "repo")
	if err == nil {
		t.Fatal("expected error for 422 (fork already exists)")
	}
	if !strings.Contains(err.Error(), "fork already exists") {
		t.Errorf("error should mention fork already exists: %v", err)
	}
}

func TestHTTPGitHubClient_CreateFork_403(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"message":"forbidden"}`)
	}))
	defer ts.Close()

	client := testGitHubClient(ts)
	_, err := client.CreateFork(context.Background(), FakeGitHubToken, "owner", "repo")
	if err == nil {
		t.Fatal("expected error for 403")
	}
}

func TestHTTPGitHubClient_WaitForkReady_200(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	client := testGitHubClient(ts)
	err := client.WaitForkReady(context.Background(), FakeGitHubToken, "owner", "repo")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestHTTPGitHubClient_WaitForkReady_404(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer ts.Close()

	client := testGitHubClient(ts)
	// Use a context with cancel to stop polling after first 404
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediate cancellation — WaitForkReady should return ctx.Err()

	err := client.WaitForkReady(ctx, FakeGitHubToken, "owner", "repo")
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled, got: %v", err)
	}
}

func TestHTTPGitHubClient_NewRequest_BasicAuth(t *testing.T) {
	client := &httpGitHubClient{httpClient: http.DefaultClient, baseURL: "https://api.github.com"}
	req, err := client.newRequest(context.Background(), "GET", "/user", FakeGitHubToken, nil)
	if err != nil {
		t.Fatalf("newRequest failed: %v", err)
	}
	if req.Header.Get("Authorization") != "Bearer "+FakeGitHubToken {
		t.Errorf("expected Bearer token, got: %s", req.Header.Get("Authorization"))
	}
	if req.Header.Get("Accept") != "application/vnd.github.v3+json" {
		t.Errorf("expected v3 accept header, got: %s", req.Header.Get("Accept"))
	}
}

func TestHTTPGitHubClient_NewRequest_NoToken(t *testing.T) {
	client := &httpGitHubClient{httpClient: http.DefaultClient, baseURL: "https://api.github.com"}
	req, err := client.newRequest(context.Background(), "GET", "/user", "", nil)
	if err != nil {
		t.Fatalf("newRequest failed: %v", err)
	}
	if req.Header.Get("Authorization") != "" {
		t.Errorf("expected no Authorization header for empty token, got: %s", req.Header.Get("Authorization"))
	}
}

// ──────────────────────────────────────────────
// ParseGitHubURL tests
// ──────────────────────────────────────────────

func TestParseGitHubURL_FullHTTPS(t *testing.T) {
	owner, repo := ParseGitHubURL("https://github.com/owner/repo.git")
	if owner != "owner" || repo != "repo" {
		t.Errorf("expected owner/repo, got %s/%s", owner, repo)
	}
}

func TestParseGitHubURL_FullHTTPSNoSuffix(t *testing.T) {
	owner, repo := ParseGitHubURL("https://github.com/owner/repo")
	if owner != "owner" || repo != "repo" {
		t.Errorf("expected owner/repo, got %s/%s", owner, repo)
	}
}

func TestParseGitHubURL_Short(t *testing.T) {
	owner, repo := ParseGitHubURL("owner/repo")
	if owner != "owner" || repo != "repo" {
		t.Errorf("expected owner/repo, got %s/%s", owner, repo)
	}
}

func TestParseGitHubURL_Empty(t *testing.T) {
	owner, repo := ParseGitHubURL("")
	if owner != "" || repo != "" {
		t.Errorf("expected empty/empty, got %s/%s", owner, repo)
	}
}

// ──────────────────────────────────────────────
// gitCloneWorktree / gitAddSubmodule / redactToken (runner-seam) tests
// ──────────────────────────────────────────────

func TestRedactToken_ReplacesOccurrences(t *testing.T) {
	got := redactToken("fatal: https://oauth2:"+FakeGitHubToken+"@github.com/a/b.git\nremote: "+FakeGitHubToken, FakeGitHubToken)
	if strings.Contains(got, FakeGitHubToken) {
		t.Errorf("token should be redacted: %q", got)
	}
	if !strings.Contains(got, "***") {
		t.Errorf("redaction marker missing: %q", got)
	}
}

func TestRedactToken_EmptyTokenNoOp(t *testing.T) {
	text := "no token here"
	if got := redactToken(text, ""); got != text {
		t.Errorf("empty token should no-op, got %q", got)
	}
}

func TestGitCloneWorktree_InvalidURL(t *testing.T) {
	saved := runCommandContext
	called := false
	runCommandContext = func(_ context.Context, _ string, _ ...string) runner {
		called = true
		return &mockCmd{}
	}
	defer func() { runCommandContext = saved }()

	err := gitCloneWorktree(context.Background(), FakeGitHubToken, "not-a-url", t.TempDir())
	if err == nil {
		t.Fatal("expected error for invalid URL")
	}
	if !strings.Contains(err.Error(), "invalid repo URL") {
		t.Errorf("error should mention invalid repo URL: %v", err)
	}
	if called {
		t.Error("seam should not be called for invalid URL")
	}
}

func TestGitCloneWorktree_HappyPath(t *testing.T) {
	var calls [][]string
	saved := runCommandContext
	runCommandContext = func(_ context.Context, _ string, arg ...string) runner {
		calls = append(calls, arg)
		if arg[0] == "clone" {
			return &mockCmd{}
		}
		if len(arg) > 2 && arg[2] == "symbolic-ref" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("refs/remotes/origin/master"), nil }}
		}
		return &mockCmd{}
	}
	defer func() { runCommandContext = saved }()

	workdir := filepath.Join(t.TempDir(), "repo")
	err := gitCloneWorktree(context.Background(), FakeGitHubToken, "https://github.com/owner/repo.git", workdir)
	if err != nil {
		t.Fatalf("gitCloneWorktree failed: %v", err)
	}
	if len(calls) != 3 {
		t.Fatalf("expected 3 seam calls, got %d: %v", len(calls), calls)
	}
	// bare clone: git clone --bare <authURL> <parent>/.bare
	clone := calls[0]
	if strings.Join(clone[:2], " ") != "clone --bare" {
		t.Errorf("expected clone --bare, got %v", clone)
	}
	if clone[2] != "https://oauth2:"+FakeGitHubToken+"@github.com/owner/repo.git" {
		t.Errorf("expected tokenized URL, got %q", clone[2])
	}
	if !strings.HasSuffix(clone[3], "/.bare") {
		t.Errorf("expected .bare dest, got %q", clone[3])
	}
	// worktree add: git --git-dir <bare> worktree add --detach <workdir> master
	wt := calls[2]
	if strings.Join(wt[2:5], " ") != "worktree add --detach" {
		t.Errorf("expected worktree add --detach, got %v", wt)
	}
	if wt[5] != workdir || wt[6] != "master" {
		t.Errorf("expected worktree add %s master, got %v", workdir, wt)
	}
}

func TestGitCloneWorktree_DefaultBranchFallback(t *testing.T) {
	var worktreeArgs []string
	saved := runCommandContext
	runCommandContext = func(_ context.Context, _ string, arg ...string) runner {
		if len(arg) > 2 && arg[2] == "symbolic-ref" {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("HEAD not found") }}
		}
		if arg[0] == "clone" {
			return &mockCmd{}
		}
		worktreeArgs = arg
		return &mockCmd{}
	}
	defer func() { runCommandContext = saved }()

	err := gitCloneWorktree(context.Background(), FakeGitHubToken, "https://github.com/owner/repo.git", filepath.Join(t.TempDir(), "repo"))
	if err != nil {
		t.Fatalf("gitCloneWorktree failed: %v", err)
	}
	if len(worktreeArgs) == 0 || worktreeArgs[len(worktreeArgs)-1] != "main" {
		t.Errorf("expected fallback branch 'main', got %v", worktreeArgs)
	}
}

func TestGitCloneWorktree_BareCloneError(t *testing.T) {
	const token = FakeGitHubToken
	// Output echoes the token as git would when echoing the URL.
	output := []byte("fatal: unable to access 'https://oauth2:" + token + "@github.com/owner/repo.git/': Could not resolve host")
	saved := runCommandContext
	runCommandContext = func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{combinedFn: func() ([]byte, error) { return output, fmt.Errorf("exit status 128") }}
	}
	defer func() { runCommandContext = saved }()

	err := gitCloneWorktree(context.Background(), token, "https://github.com/owner/repo.git", filepath.Join(t.TempDir(), "repo"))
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "bare clone failed") {
		t.Errorf("error should mention bare clone failed: %v", err)
	}
	if strings.Contains(err.Error(), token) {
		t.Errorf("token must be redacted from error: %v", err)
	}
}

func TestGitCloneWorktree_WorktreeAddError(t *testing.T) {
	saved := runCommandContext
	step := 0
	runCommandContext = func(_ context.Context, _ string, arg ...string) runner {
		step++
		if step == 1 { // bare clone
			return &mockCmd{}
		}
		if len(arg) > 2 && arg[2] == "symbolic-ref" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("refs/remotes/origin/main"), nil }}
		}
		return &mockCmd{combinedFn: func() ([]byte, error) { return []byte("fatal: worktree error"), fmt.Errorf("exit status 128") }}
	}
	defer func() { runCommandContext = saved }()

	err := gitCloneWorktree(context.Background(), FakeGitHubToken, "https://github.com/owner/repo.git", filepath.Join(t.TempDir(), "repo"))
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "worktree add failed") {
		t.Errorf("error should mention worktree add failed: %v", err)
	}
}

func TestGitAddSubmodule_CapturesArgsAndDir(t *testing.T) {
	var capturedArgs []string
	var captured *mockCmd
	saved := runCommandContext
	runCommandContext = func(_ context.Context, _ string, arg ...string) runner {
		capturedArgs = arg
		captured = &mockCmd{}
		return captured
	}
	defer func() { runCommandContext = saved }()

	repoPath := t.TempDir()
	if err := gitAddSubmodule(context.Background(), repoPath, "flask_blogs", "https://github.com/user/flask_blogs"); err != nil {
		t.Fatalf("gitAddSubmodule failed: %v", err)
	}
	want := strings.Join([]string{"submodule", "add", "https://github.com/user/flask_blogs", "flask_blogs"}, " ")
	if strings.Join(capturedArgs, " ") != want {
		t.Errorf("expected (%s), got %v", want, capturedArgs)
	}
	if captured.dir != repoPath {
		t.Errorf("expected Dir=%q, got %q", repoPath, captured.dir)
	}
}

func TestGitAddSubmodule_ErrorWrapsOutput(t *testing.T) {
	saved := runCommandContext
	runCommandContext = func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{combinedFn: func() ([]byte, error) {
			return []byte("fatal: path 'x' is already tracked"), fmt.Errorf("exit status 128")
		}}
	}
	defer func() { runCommandContext = saved }()

	err := gitAddSubmodule(context.Background(), t.TempDir(), "x", "https://github.com/a/b.git")
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "git submodule add") {
		t.Errorf("error should mention git submodule add: %v", err)
	}
	if !strings.Contains(err.Error(), "already tracked") {
		t.Errorf("error should include output: %v", err)
	}
}

// ──────────────────────────────────────────────
// go-git backed ops (no git binary needed for error paths)
// ──────────────────────────────────────────────

func TestGitListSubmodules_NotARepo(t *testing.T) {
	_, err := (gitSubmoduleOps{}).ListSubmodules(context.Background(), t.TempDir())
	if err == nil {
		t.Fatal("expected error for non-repo dir")
	}
	if !strings.Contains(err.Error(), "open repo") {
		t.Errorf("error should mention open repo: %v", err)
	}
}

// TestGitListSubmodules_RoundTrip writes a plain .gitmodules into an
// uninitialized repo (no matching .git/config entries, so results mirror the
// file directly, sidestepping go-git's Path-override merge) and asserts the
// returned config.Submodule values match it.
func TestGitListSubmodules_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	if _, err := git.PlainInit(dir, false); err != nil {
		t.Fatalf("git init: %v", err)
	}

	const gitmodules = `[submodule "flask_blogs"]
	path = flask_blogs
	url = ../flask_blogs
[submodule "private-pi"]
	path = private-pi/skills
	url = ../private-pi
`
	if err := os.WriteFile(filepath.Join(dir, ".gitmodules"), []byte(gitmodules), 0644); err != nil {
		t.Fatalf("write .gitmodules: %v", err)
	}

	subs, err := (gitSubmoduleOps{}).ListSubmodules(context.Background(), dir)
	if err != nil {
		t.Fatalf("ListSubmodules: %v", err)
	}
	if len(subs) != 2 {
		t.Fatalf("expected 2 submodules, got %d", len(subs))
	}

	// go-git stores submodules in a map (config.Modules.Submodules), so
	// iteration order is nondeterministic — compare as a name-keyed set.
	byName := make(map[string]config.Submodule, len(subs))
	for _, s := range subs {
		byName[s.Name] = s
	}
	want := []config.Submodule{
		{Name: "flask_blogs", Path: "flask_blogs", URL: "../flask_blogs"},
		{Name: "private-pi", Path: "private-pi/skills", URL: "../private-pi"},
	}
	for _, w := range want {
		got, ok := byName[w.Name]
		if !ok {
			t.Errorf("submodule %q missing from results: %+v", w.Name, subs)
			continue
		}
		if got.Name != w.Name || got.Path != w.Path || got.URL != w.URL {
			t.Errorf("submodule %q: got %+v, want %+v", w.Name, got, w)
		}
		if got.Branch != "" {
			t.Errorf("submodule %q: expected empty Branch for fresh .gitmodules parse, got %q", w.Name, got.Branch)
		}
	}
}

// TestGitListSubmodules_NoGitmodules: absent .gitmodules yields an empty
// slice and nil error (preserves runInitSubmodule's "No submodules found").
func TestGitListSubmodules_NoGitmodules(t *testing.T) {
	dir := t.TempDir()
	if _, err := git.PlainInit(dir, false); err != nil {
		t.Fatalf("git init: %v", err)
	}

	subs, err := (gitSubmoduleOps{}).ListSubmodules(context.Background(), dir)
	if err != nil {
		t.Fatalf("ListSubmodules: %v", err)
	}
	if len(subs) != 0 {
		t.Errorf("expected empty result, got %d submodules", len(subs))
	}
}

// TestGitListSubmodules_GitmodulesSymlink: a symlinked .gitmodules surfaces
// go-git's ErrGitModulesSymlink wrapped as "list submodules".
func TestGitListSubmodules_GitmodulesSymlink(t *testing.T) {
	dir := t.TempDir()
	if _, err := git.PlainInit(dir, false); err != nil {
		t.Fatalf("git init: %v", err)
	}
	target := filepath.Join(t.TempDir(), "real-gitmodules")
	if err := os.WriteFile(target, []byte("[submodule]\n"), 0644); err != nil {
		t.Fatalf("write target: %v", err)
	}
	if err := os.Symlink(target, filepath.Join(dir, ".gitmodules")); err != nil {
		t.Skipf("os.Symlink unsupported: %v", err)
	}

	_, err := (gitSubmoduleOps{}).ListSubmodules(context.Background(), dir)
	if err == nil {
		t.Fatal("expected error for symlinked .gitmodules")
	}
	if !strings.Contains(err.Error(), "list submodules") {
		t.Errorf("error should mention list submodules: %v", err)
	}
}

func TestGitSetSubmoduleURL_NotARepo(t *testing.T) {
	err := (gitSubmoduleOps{}).SetSubmoduleURL(context.Background(), t.TempDir(), "x", "https://a/b.git")
	if err == nil {
		t.Fatal("expected error for non-repo dir")
	}
	if !strings.Contains(err.Error(), "open repo") {
		t.Errorf("error should mention open repo: %v", err)
	}
}

func TestGitInitAndUpdateSubmodules_NotARepo(t *testing.T) {
	err := (gitSubmoduleOps{}).InitAndUpdateSubmodules(context.Background(), t.TempDir())
	if err == nil {
		t.Fatal("expected error for non-repo dir")
	}
	if !strings.Contains(err.Error(), "open repo") {
		t.Errorf("error should mention open repo: %v", err)
	}
}

func TestGitClone_LocalBareRepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	src := t.TempDir()
	runGit := func(args ...string) error {
		cmd := exec.Command("git", args...)
		cmd.Dir = src
		return cmd.Run()
	}
	if err := runGit("init", "-q"); err != nil {
		t.Fatalf("git init: %v", err)
	}
	if err := os.WriteFile(filepath.Join(src, "file.txt"), []byte("hello"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	if err := runGit("add", "file.txt"); err != nil {
		t.Fatalf("git add: %v", err)
	}
	if err := runGit("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"); err != nil {
		t.Fatalf("git commit: %v", err)
	}

	// Bogus token: go-git BasicAuth is ignored for local paths, clone succeeds.
	dest := filepath.Join(t.TempDir(), "clone")
	if err := gitClone(context.Background(), FakeGitHubToken, src, dest); err != nil {
		t.Fatalf("gitClone failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dest, "file.txt")); err != nil {
		t.Errorf("expected cloned file: %v", err)
	}
}

func TestGitClone_UnreadableSource(t *testing.T) {
	err := gitClone(context.Background(), FakeGitHubToken, filepath.Join(t.TempDir(), "nonexistent"), filepath.Join(t.TempDir(), "clone"))
	if err == nil {
		t.Fatal("expected error for unreadable source")
	}
	if !strings.Contains(err.Error(), "clone failed") {
		t.Errorf("error should mention clone failed: %v", err)
	}
}
