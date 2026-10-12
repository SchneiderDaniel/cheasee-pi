package main

import (
	"bytes"
	"context"
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunReauth_RedoesAuthAndPreservesProviders(t *testing.T) {
	// Interactive reauth through runInit: docker check + probe routing +
	// device flow + user resolution + merge-safe patch + provider phase
	// (declined). No clone, no scaffold, no repo-URL input.
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	// Pre-seeded providers must survive the github patch (merge-safe).
	seedAuth(t, map[string]string{"openai": "key-openai", "anthropic": "key-anthropic"})

	workdir := t.TempDir()
	settings := `{"oauth":{"clientID":"app-123"},"docker":{"memory":"2G"},"gitIdentity":{"name":"N","email":"e@x"},"defaultProvider":"openai"}`
	testutil.WriteCheaseeSettingsFile(t, workdir, settings)

	// The default mock Authenticator already resolves the login (octocat),
	// so no HTTP seam is needed.
	var gitCalls int
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "git" {
			gitCalls++
		}
		return saved(ctx, name, arg...)
	})

	inputCalled := false
	var err error
	stderr := testutil.CaptureStderr(t, func() {
		err = runInit(context.Background(), initDeps(t, func(d *InitDeps) {
			d.Workdir = workdir
			d.Reauth = true
			d.NoInput = false
			d.InputFn = func(title, placeholder string) (string, error) {
				inputCalled = true
				return "", nil
			}
			d.ConfirmFn = mockConfirmFn(true, nil, "Configure API keys")
		}))
	})
	if err != nil {
		t.Fatalf("reauth through runInit failed: %v", err)
	}

	if gitCalls != 0 {
		t.Errorf("reauth must not clone (no git argv), got %d git calls", gitCalls)
	}
	if inputCalled {
		t.Error("reauth must not ask for a repo URL (InputFn must never be called)")
	}
	if _, statErr := os.Stat(filepath.Join(filepath.Dir(workdir), ".bare")); !os.IsNotExist(statErr) {
		t.Errorf("reauth must not create <parent>/.bare: %v", statErr)
	}

	raw := readAuthJSON(t)
	if got := authField(t, raw, "github_token"); got != FakeGitHubToken {
		t.Errorf("expected fresh github_token %q, got %q", FakeGitHubToken, got)
	}
	if got := authField(t, raw, "github_user"); got != "octocat" {
		t.Errorf("expected github_user %q, got %q", "octocat", got)
	}
	if got := authField(t, raw, "repo_path"); got != workdir {
		t.Errorf("expected repo_path %q, got %q", workdir, got)
	}
	providers, err := (&fileRepository{}).ListProviders(context.Background())
	if err != nil {
		t.Fatalf("ListProviders: %v", err)
	}
	if providers["openai"] != "key-openai" || providers["anthropic"] != "key-anthropic" {
		t.Errorf("pre-seeded providers must survive the patch, got %v", providers)
	}

	got, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	if string(got) != settings {
		t.Errorf("settings file must be preserved byte-identical (provider phase declined), got:\n%s", got)
	}

	if !strings.Contains(stderr, "✓ GitHub credentials updated for octocat") {
		t.Errorf("success line should name the resolved user, stderr:\n%s", stderr)
	}
	if !strings.Contains(stderr, "https://github.com/settings/connections/applications") {
		t.Errorf("stderr should print the revocation URL, stderr:\n%s", stderr)
	}
}

func TestRunReauth_NoInputSkipsProviderPhase(t *testing.T) {
	// --no-input --reauth: the flag is the confirmation — ConfirmFn is never
	// called, the provider phase is skipped, auth.json is still updated.
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)

	confirmCalled := false
	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.NoInput = true
		d.ConfirmFn = func(string) (bool, error) {
			confirmCalled = true
			return true, nil
		}
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if confirmCalled {
		t.Error("--no-input must not call ConfirmFn (the flag is the confirmation)")
	}
	raw := readAuthJSON(t)
	if got := authField(t, raw, "github_token"); got != FakeGitHubToken {
		t.Errorf("auth.json must carry the fresh github_token, got %q", got)
	}
	if got := authField(t, raw, "github_user"); got != "octocat" {
		t.Errorf("auth.json must carry the fresh github_user, got %q", got)
	}
	if got := authField(t, raw, "repo_path"); got != workdir {
		t.Errorf("auth.json must carry the fresh repo_path, got %q", got)
	}
}

func TestRunReauth_CreatesAuthJSONWhenMissing(t *testing.T) {
	// Settings present but auth.json missing → reauth creates auth.json with
	// the github fields.
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)

	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !authJSONExists(t) {
		t.Fatal("reauth must create auth.json when missing")
	}
	raw := readAuthJSON(t)
	if got := authField(t, raw, "github_token"); got != FakeGitHubToken {
		t.Errorf("expected fresh github_token, got %q", got)
	}
	if got := authField(t, raw, "github_user"); got != "octocat" {
		t.Errorf("expected fresh github_user, got %q", got)
	}
	if got := authField(t, raw, "repo_path"); got != workdir {
		t.Errorf("expected fresh repo_path, got %q", got)
	}
}

func TestRunReauth_ErrUnsupportedHardErrors(t *testing.T) {
	// device.ErrUnsupported on an initialized workspace is a hard error
	// naming --client-id — NO legacy API-key fallback, no provider re-prompt,
	// auth.json untouched.
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	auth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return nil, device.ErrUnsupported
		},
	}
	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.Ports = InitPorts{Auth: auth}
	}))
	if err == nil || !strings.Contains(err.Error(), "--client-id") {
		t.Fatalf("expected hard error naming --client-id, got: %v", err)
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("auth.json must be untouched on ErrUnsupported")
	}
}

func TestRunReauth_DeviceFlowFailureWrapsGitHubAuthError(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	auth := &mockAuthenticator{
		waitFunc: func(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error) {
			return nil, fmt.Errorf("expired_token: device code expired")
		},
	}
	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.Ports = InitPorts{Auth: auth}
	}))
	if err == nil || !strings.Contains(err.Error(), "GitHub authentication failed") || !strings.Contains(err.Error(), "expired_token") {
		t.Fatalf("expected wrapped GitHub authentication failure, got: %v", err)
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("no partial auth.json may be written on device-flow failure")
	}
}

func TestRunReauth_ResolveUserFailureLeavesAuthUntouched(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	// The mock's User fails (the real deviceFlowAuthenticator fail-opens
	// inside runInitAuth, warning on stderr); runReauth treats the empty
	// login as a hard error and leaves auth.json untouched.
	auth := &mockAuthenticator{
		userFunc: func(ctx context.Context, token string) (string, error) {
			return "", fmt.Errorf("GET /user: 401 Unauthorized")
		},
	}
	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.Ports = InitPorts{Auth: auth}
	}))
	if err == nil || !strings.Contains(err.Error(), "resolve GitHub user") {
		t.Fatalf("expected user-resolution failure, got: %v", err)
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("auth.json must not be patched when user resolution fails (no partial token write)")
	}
}

func TestRunReauth_DeclineAbortsLeavingAuthIdentical(t *testing.T) {
	// Interactive: explicit confirmation gates before the device flow;
	// declining aborts with auth.json byte-identical.
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	flowCalled := false
	auth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			flowCalled = true
			return &device.CodeResponse{UserCode: "ABCD-1234", DeviceCode: "dc", VerificationURI: "https://github.com/login/device"}, nil
		},
	}
	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.NoInput = false
		d.ConfirmFn = func(string) (bool, error) { return false, nil }
		d.Ports = InitPorts{Auth: auth}
	}))
	if err != nil {
		t.Fatalf("declining re-auth must not error, got: %v", err)
	}
	if flowCalled {
		t.Error("device flow must not run after the confirmation is declined")
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("auth.json must be byte-identical after declined re-auth")
	}
}

func TestRunReauth_MalformedSettingsFailsClosed(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, "cheasee-settings.json"), []byte("{not json}"), 0644); err != nil {
		t.Fatal(err)
	}
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	flowCalled := false
	auth := &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			flowCalled = true
			return &device.CodeResponse{}, nil
		},
	}
	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.Ports = InitPorts{Auth: auth}
	}))
	if err == nil || !strings.Contains(err.Error(), "cheasee-settings.json") {
		t.Fatalf("expected fail-closed settings error, got: %v", err)
	}
	if flowCalled {
		t.Error("device flow must not run when settings are malformed")
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("auth.json must be untouched when settings are malformed")
	}
}

func TestRunReauth_DockerCheckStillRuns(t *testing.T) {
	// Docker check runs before the reauth routing — docker-not-installed
	// aborts with auth.json untouched.
	testutil.RedirectConfigHome(t)
	stubLookPath(t, func(_ string) (string, error) { return "", fmt.Errorf("executable not found in $PATH") })
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
	}))
	if err == nil || !strings.Contains(err.Error(), "Docker is not installed") {
		t.Fatalf("expected docker-not-installed error on the reauth path, got: %v", err)
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("auth.json must be untouched when the docker check fails")
	}
}

func TestRunReauth_NoGitHubRedoesProviderPhaseOnly(t *testing.T) {
	// --reauth --no-github: provider-key phase only — no device flow, no
	// github patch. With --no-input nothing is written (auth.json untouched).
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	err := runReauth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.NoGitHub = true
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("auth.json must not be partially updated on --no-github --no-input reauth")
	}
}
