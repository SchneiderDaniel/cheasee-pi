package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	goGitHTTP "github.com/go-git/go-git/v5/plumbing/transport/http"
)

// ──────────────────────────────────────────────
// Ports
// ──────────────────────────────────────────────

// Authenticator handles GitHub OAuth device flow authentication.
type Authenticator interface {
	RequestCode(ctx context.Context, scopes []string) (*device.CodeResponse, error)
	Wait(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error)
}

// GitHubClient handles GitHub API operations.
type GitHubClient interface {
	GetAuthenticatedUser(ctx context.Context, token string) (string, error)
	CreateFork(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error)
	WaitForkReady(ctx context.Context, token, owner, repo string) error
}

// Submodule represents a git submodule entry from .gitmodules.
type Submodule struct {
	Name string
	Path string
	URL  string
}

// submoduleOps performs submodule operations on a local git checkout.
// The go-git backed ops run directly against the working tree; AddSubmodule
// shells out to git. Kept as a narrow parameter so runInit orchestration
// tests can inject a fake — there is no second production adapter.
type submoduleOps interface {
	// ListSubmodules returns all submodules defined in .gitmodules.
	ListSubmodules(ctx context.Context, repoPath string) ([]Submodule, error)
	// SetSubmoduleURL rewrites the URL for a named submodule in .gitmodules
	// and syncs it to .git/config via Init.
	SetSubmoduleURL(ctx context.Context, repoPath, name, newURL string) error
	// InitAndUpdateSubmodules runs git submodule init + update --init --recursive.
	InitAndUpdateSubmodules(ctx context.Context, repoPath string) error
	// AddSubmodule runs git submodule add for a new submodule.
	AddSubmodule(ctx context.Context, repoPath, name, url string) error
}

// ──────────────────────────────────────────────
// Authenticator: deviceFlowAuthenticator
// ──────────────────────────────────────────────

type deviceFlowAuthenticator struct {
	clientID   string
	httpClient *http.Client
}

// NewAuthenticator creates a device flow authenticator with the given GitHub OAuth client ID.
func NewAuthenticator(clientID string) Authenticator {
	return &deviceFlowAuthenticator{
		clientID:   clientID,
		httpClient: http.DefaultClient,
	}
}

func (a *deviceFlowAuthenticator) RequestCode(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
	return device.RequestCode(
		a.httpClient,
		"https://github.com/login/device/code",
		a.clientID,
		scopes,
	)
}

func (a *deviceFlowAuthenticator) Wait(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error) {
	return device.Wait(ctx, a.httpClient, "https://github.com/login/oauth/access_token", device.WaitOptions{
		ClientID:   a.clientID,
		DeviceCode: code,
	})
}

// ──────────────────────────────────────────────
// GitHubClient: httpGitHubClient
// ──────────────────────────────────────────────

type httpGitHubClient struct {
	httpClient *http.Client
	baseURL    string // optional, for testing
}

// NewGitHubClient creates a GitHub API client.
func NewGitHubClient() GitHubClient {
	return &httpGitHubClient{httpClient: http.DefaultClient, baseURL: "https://api.github.com"}
}

// newRequest creates an authenticated HTTP request with GitHub API headers.
func (c *httpGitHubClient) newRequest(ctx context.Context, method, path, token string, body io.Reader) (*http.Request, error) {
	url := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

func (c *httpGitHubClient) GetAuthenticatedUser(ctx context.Context, token string) (string, error) {
	req, err := c.newRequest(ctx, "GET", "/user", token, nil)
	if err != nil {
		return "", err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("user API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return "", fmt.Errorf("invalid token: unauthorized (401)")
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("user API returned %d: %s", resp.StatusCode, string(body))
	}

	var user struct {
		Login string `json:"login"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
		return "", fmt.Errorf("failed to decode user response: %w", err)
	}
	if user.Login == "" {
		return "", fmt.Errorf("user API returned nil login")
	}
	return user.Login, nil
}

func (c *httpGitHubClient) CreateFork(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error) {
	path := fmt.Sprintf("/repos/%s/%s/forks", sourceOwner, sourceRepo)
	req, err := c.newRequest(ctx, "POST", path, token, strings.NewReader("{}"))
	if err != nil {
		return "", err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fork request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	// 202 Accepted — fork is being created asynchronously
	// 422 Unprocessable Entity — fork already exists (common case)
	if resp.StatusCode == http.StatusUnprocessableEntity {
		return "", fmt.Errorf("fork already exists: %s", strings.TrimSpace(string(body)))
	}
	if resp.StatusCode != http.StatusAccepted {
		return "", fmt.Errorf("fork API returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var fork struct {
		Owner *struct {
			Login string `json:"login"`
		} `json:"owner"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(body, &fork); err != nil {
		return "", fmt.Errorf("failed to decode fork response: %w", err)
	}
	if fork.Owner == nil || fork.Owner.Login == "" {
		return "", fmt.Errorf("fork response missing owner")
	}
	return fmt.Sprintf("%s/%s", fork.Owner.Login, fork.Name), nil
}

func (c *httpGitHubClient) WaitForkReady(ctx context.Context, token, owner, repo string) error {
	path := fmt.Sprintf("/repos/%s/%s", owner, repo)
	interval := 5 * time.Second
	cap := 5 * time.Minute
	deadline := time.Now().Add(cap)

	for {
		req, err := c.newRequest(ctx, "GET", path, token, nil)
		if err != nil {
			return err
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			return fmt.Errorf("fork ready check failed: %w", err)
		}
		resp.Body.Close()

		if resp.StatusCode == http.StatusOK {
			return nil
		}
		if resp.StatusCode == http.StatusNotFound {
			if time.Now().After(deadline) {
				return fmt.Errorf("fork not ready after %s timeout", cap)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(interval):
				continue
			}
		}

		return fmt.Errorf("unexpected status %d checking fork", resp.StatusCode)
	}
}

// ──────────────────────────────────────────────
// Clone/submodule ops: free funcs + gitSubmoduleOps (no port)
// ──────────────────────────────────────────────

// gitClone clones a repo with go-git using HTTPS BasicAuth token auth.
func gitClone(ctx context.Context, token, repoURL, destPath string) error {
	auth := &goGitHTTP.BasicAuth{
		Username: "",     // Must be empty for GitHub token auth
		Password: token,
	}

	_, err := git.PlainCloneContext(ctx, destPath, false, &git.CloneOptions{
		URL:  repoURL,
		Auth: auth,
	})
	if err != nil {
		return fmt.Errorf("clone failed: %w", err)
	}
	return nil
}

// gitCloneWorktree clones bare and creates a worktree.
func gitCloneWorktree(ctx context.Context, token, repoURL, workdir string) error {
	sourceOwner, sourceRepoName := ParseGitHubURL(repoURL)
	if sourceOwner == "" || sourceRepoName == "" {
		return fmt.Errorf("invalid repo URL: %s", repoURL)
	}

	parentDir := filepath.Dir(workdir)
	bareDir := filepath.Join(parentDir, ".bare")

	// Build URL with embedded token for git CLI auth
	authRepoURL := fmt.Sprintf("https://oauth2:%s@github.com/%s/%s.git", token, sourceOwner, sourceRepoName)

	// Create parent directory
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return fmt.Errorf("create parent dir: %w", err)
	}

	// Clone bare
	cmd := runCommandContext(ctx, "git", "clone", "--bare", authRepoURL, bareDir)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("bare clone failed: %w\n%s", err, redactToken(string(out), token))
	}

	// Detect default branch
	defaultBranch := "main"
	branchCmd := runCommandContext(ctx, "git", "--git-dir", bareDir, "symbolic-ref", "refs/remotes/origin/HEAD")
	if out, err := branchCmd.Output(); err == nil {
		ref := strings.TrimSpace(string(out))
		if parts := strings.Split(ref, "/"); len(parts) > 0 {
			if last := parts[len(parts)-1]; last != "" {
				defaultBranch = last
			}
		}
	}

	// Create worktree
	wtCmd := runCommandContext(ctx, "git", "--git-dir", bareDir, "worktree", "add", "--detach", workdir, defaultBranch)
	if out, err := wtCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("worktree add failed: %w\n%s", err, redactToken(string(out), token))
	}

	fmt.Fprintf(os.Stderr, "  ✓ Cloned (bare + worktree) to %s\n", workdir)
	return nil
}

// redactToken replaces occurrences of token in text with "***" so CLI error
// output never echoes the credential. No-op for an empty token.
func redactToken(text, token string) string {
	if token == "" {
		return text
	}
	return strings.ReplaceAll(text, token, "***")
}

// gitAddSubmodule runs git submodule add for a new submodule.
func gitAddSubmodule(ctx context.Context, repoPath, name, url string) error {
	cmd := runCommandContext(ctx, "git", "submodule", "add", url, name)
	cmd.SetDir(repoPath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git submodule add %s %s: %w\nOutput: %s", url, name, err, string(output))
	}
	return nil
}

// gitSubmoduleOps implements submoduleOps backed by go-git.
type gitSubmoduleOps struct{}

func (gitSubmoduleOps) ListSubmodules(ctx context.Context, repoPath string) ([]Submodule, error) {
	repo, err := git.PlainOpen(repoPath)
	if err != nil {
		return nil, fmt.Errorf("open repo: %w", err)
	}

	wt, err := repo.Worktree()
	if err != nil {
		return nil, fmt.Errorf("get worktree: %w", err)
	}

	subs, err := wt.Submodules()
	if err != nil {
		return nil, fmt.Errorf("list submodules: %w", err)
	}

	result := make([]Submodule, 0, len(subs))
	for _, sub := range subs {
		cfg := sub.Config()
		result = append(result, Submodule{
			Name: cfg.Name,
			Path: cfg.Path,
			URL:  cfg.URL,
		})
	}
	return result, nil
}

func (gitSubmoduleOps) SetSubmoduleURL(ctx context.Context, repoPath, name, newURL string) error {
	repo, err := git.PlainOpen(repoPath)
	if err != nil {
		return fmt.Errorf("open repo: %w", err)
	}

	// Parse .gitmodules using config.Modules for safe structured editing
	gitmodulesPath := filepath.Join(repoPath, ".gitmodules")
	data, err := os.ReadFile(gitmodulesPath)
	if err != nil {
		return fmt.Errorf("read .gitmodules: %w", err)
	}

	modules := config.NewModules()
	if err := modules.Unmarshal(data); err != nil {
		return fmt.Errorf("parse .gitmodules: %w", err)
	}

	subCfg, ok := modules.Submodules[name]
	if !ok {
		return fmt.Errorf("submodule %q not found in .gitmodules", name)
	}
	subCfg.URL = newURL

	newData, err := modules.Marshal()
	if err != nil {
		return fmt.Errorf("marshal .gitmodules: %w", err)
	}

	if err := os.WriteFile(gitmodulesPath, newData, 0644); err != nil {
		return fmt.Errorf("write .gitmodules: %w", err)
	}

	// Sync new URL from .gitmodules to .git/config via Init
	wt, err := repo.Worktree()
	if err != nil {
		return fmt.Errorf("get worktree: %w", err)
	}

	sub, err := wt.Submodule(subCfg.Path)
	if err != nil {
		return fmt.Errorf("find submodule %q in worktree: %w", name, err)
	}
	if err := sub.Init(); err != nil {
		return fmt.Errorf("init submodule %q: %w", name, err)
	}

	return nil
}

func (gitSubmoduleOps) InitAndUpdateSubmodules(ctx context.Context, repoPath string) error {
	repo, err := git.PlainOpen(repoPath)
	if err != nil {
		return fmt.Errorf("open repo: %w", err)
	}

	wt, err := repo.Worktree()
	if err != nil {
		return fmt.Errorf("get worktree: %w", err)
	}

	subs, err := wt.Submodules()
	if err != nil {
		return fmt.Errorf("list submodules: %w", err)
	}

	if err := subs.Init(); err != nil {
		return fmt.Errorf("init submodules: %w", err)
	}

	if err := subs.UpdateContext(ctx, &git.SubmoduleUpdateOptions{
		Init:              true,
		RecurseSubmodules: git.DefaultSubmoduleRecursionDepth,
	}); err != nil {
		return fmt.Errorf("update submodules: %w", err)
	}

	return nil
}

func (gitSubmoduleOps) AddSubmodule(ctx context.Context, repoPath, name, url string) error {
	return gitAddSubmodule(ctx, repoPath, name, url)
}

// ParseGitHubURL parses "owner/repo" from various GitHub URL formats.
func ParseGitHubURL(url string) (owner, repo string) {
	url = strings.TrimSuffix(url, ".git")
	if strings.Contains(url, "github.com/") {
		parts := strings.SplitN(url, "github.com/", 2)
		if len(parts) == 2 {
			url = parts[1]
		}
	} else if strings.Contains(url, "github.com:") {
		parts := strings.SplitN(url, "github.com:", 2)
		if len(parts) == 2 {
			url = parts[1]
		}
	}
	parts := strings.SplitN(url, "/", 3)
	if len(parts) >= 2 {
		return parts[0], strings.TrimSuffix(parts[1], ".git")
	}
	return "", ""
}
