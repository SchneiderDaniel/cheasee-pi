package main

import (
	"context"
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunInitAuth_Success(t *testing.T) {
	auth := &mockAuthenticator{}
	token, user, err := runInitAuth(context.Background(), auth)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != FakeGitHubToken {
		t.Errorf("expected %q, got %q", FakeGitHubToken, token)
	}
	if user != MockGitHubUser {
		t.Errorf("expected resolved user %q, got %q", MockGitHubUser, user)
	}
}

func TestRunInitAuth_RequestsScopes(t *testing.T) {
	// Fail-closed: the exact requested set {repo, read:org, project, workflow}
	// must be passed to RequestCode — a missing scope (e.g. workflow, once
	// omitted here and rejected by GitHub on workflow-file pushes) or an
	// extra one must fail the test.
	var got []string
	auth := &mockAuthenticator{
		requestCodeFunc: func(_ context.Context, scopes []string) (*device.CodeResponse, error) {
			got = scopes
			return &device.CodeResponse{UserCode: "ABCD-1234", VerificationURI: "https://github.com/login/device"}, nil
		},
	}
	if _, _, err := runInitAuth(context.Background(), auth); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := initGitHubScopes
	if len(got) != len(want) {
		t.Fatalf("requested %d scopes %v, want exactly %d: %v", len(got), got, len(want), want)
	}
	for i, s := range want {
		if got[i] != s {
			t.Errorf("requested scopes %v, want exactly %v", got, want)
			break
		}
	}
}

func TestRunInitAuth_UserLookupFailsOpen(t *testing.T) {
	// The GitHub login resolution is fail-open: OAuth already succeeded, so a
	// user lookup failure warns on stderr and yields an empty user — the
	// repository.user field simply stays empty ("when available").
	auth := &mockAuthenticator{
		userFunc: func(ctx context.Context, token string) (string, error) {
			return "", fmt.Errorf("GET /user failed")
		},
	}
	var token, user string
	var err error
	stderr := testutil.CaptureStderr(t, func() {
		token, user, err = runInitAuth(context.Background(), auth)
	})
	if err != nil {
		t.Fatalf("user lookup failure must not fail init: %v", err)
	}
	if token != FakeGitHubToken {
		t.Errorf("token must survive a failed lookup, got %q", token)
	}
	if user != "" {
		t.Errorf("fail-open user must be empty, got %q", user)
	}
	if !strings.Contains(stderr, "GET /user failed") {
		t.Errorf("stderr must warn about the lookup failure, got: %q", stderr)
	}
}

// ──────────────────────────────────────────────
// deviceFlowAuthenticator.User (adapter, HTTP seam)
// ──────────────────────────────────────────────

func TestDeviceFlowAuthenticator_User(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization = %q, want Bearer test-token", got)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"login":"octocat"}`)
	}))
	defer srv.Close()

	a := &deviceFlowAuthenticator{clientID: "test-client", httpClient: srv.Client(), userURL: srv.URL + "/user"}
	login, err := a.User(context.Background(), "test-token")
	if err != nil {
		t.Fatalf("User: %v", err)
	}
	if login != "octocat" {
		t.Errorf("login = %q, want octocat", login)
	}
}

func TestDeviceFlowAuthenticator_UserHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad credentials", http.StatusUnauthorized)
	}))
	defer srv.Close()

	a := &deviceFlowAuthenticator{clientID: "test-client", httpClient: srv.Client(), userURL: srv.URL + "/user"}
	if _, err := a.User(context.Background(), "test-token"); err == nil {
		t.Fatal("expected error for HTTP 401")
	}
}

func TestRunInitAuth_ExpiredToken(t *testing.T) {
	auth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return &device.CodeResponse{}, nil
		},
		waitFunc: func(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error) {
			return nil, fmt.Errorf("expired_token: device code expired")
		},
	}
	_, _, err := runInitAuth(context.Background(), auth)
	if err == nil {
		t.Fatal("expected error for expired token")
	}
	if !strings.Contains(err.Error(), "expired_token") {
		t.Errorf("error should mention expired_token: %v", err)
	}
}

func TestRunInitAuth_AccessDenied(t *testing.T) {
	auth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return &device.CodeResponse{}, nil
		},
		waitFunc: func(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error) {
			return nil, fmt.Errorf("access_denied: user cancelled")
		},
	}
	_, _, err := runInitAuth(context.Background(), auth)
	if err == nil {
		t.Fatal("expected error for access denied")
	}
	if !strings.Contains(err.Error(), "access_denied") {
		t.Errorf("error should mention access_denied: %v", err)
	}
}

func TestRunInitAuth_ContextCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	auth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return nil, ctx.Err()
		},
	}
	_, _, err := runInitAuth(ctx, auth)
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
}

func TestRunInitAuth_RequestCodeError(t *testing.T) {
	auth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return nil, fmt.Errorf("network error")
		},
	}
	_, _, err := runInitAuth(context.Background(), auth)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "network error") {
		t.Errorf("error should propagate: %v", err)
	}
}
