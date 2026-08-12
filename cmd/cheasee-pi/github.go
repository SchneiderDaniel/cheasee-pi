package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
)

// ParseGitHubURL parses "owner/repo" from the various GitHub URL formats
// cheasee-pi accepts: shorthand "owner/repo", https URLs (with or without
// .git / trailing slash), and ssh forms (git@github.com:owner/repo,
// ssh://git@github.com/owner/repo). Anything unrecognized returns empty
// owner/repo — callers refuse before any git invocation.
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

// tokenUserinfoRe matches userinfo in a URL authority ("//user:pass@" or
// "//token@") — the shape a credential-bearing clone URL takes. The literal
// ssh user "git@" (no scheme-relative slashes) is untouched.
var tokenUserinfoRe = regexp.MustCompile(`//[^/@\s]+@`)

// redactToken strips userinfo credentials from any URL-like substring in
// text so CLI error output never echoes a credential a user may have embedded
// in a pasted repo URL (git itself redacts passwords in newer versions, but
// this is defense in depth on the wrapper side). No-op for text without
// credentials.
func redactToken(text string) string {
	return tokenUserinfoRe.ReplaceAllString(text, "//***@")
}

// httpClient is the HTTP client used by resolveGitHubUser. Package-var seam
// (same pattern as lookPath/runCommandContext) so tests stub it with an
// httptest server.
var httpClient = http.DefaultClient

// resolveGitHubUser resolves the token owner's login via GET
// https://api.github.com/user — the one call needed to populate github_user
// on the re-auth path (gh CLI does the same post-flow). Non-200 responses,
// network errors, and malformed bodies are hard errors.
func resolveGitHubUser(ctx context.Context, token string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET /user returned %s", resp.Status)
	}
	var body struct {
		Login string `json:"login"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	if body.Login == "" {
		return "", errors.New("GET /user response missing login")
	}
	return body.Login, nil
}

// Authenticator handles GitHub OAuth device flow authentication.
type Authenticator interface {
	RequestCode(ctx context.Context, scopes []string) (*device.CodeResponse, error)
	Wait(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error)
}

// deviceFlowAuthenticator is the OAuth device-flow Authenticator used by init.
// The fork/clone phase (and its GitHubClient API port) was removed with the
// repo-mount restructure — init only needs the device flow to mint a token.
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
