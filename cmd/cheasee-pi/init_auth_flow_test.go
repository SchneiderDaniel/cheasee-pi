package main

import (
	"context"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/cli/oauth/device"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunInit_FullFlow(t *testing.T) {
	clone := stubInitFlow(t)

	_, workdir := newWorkspace(t)
	err := runInit(context.Background(), initDepsWithRepoURL(t, workdir))
	if err != nil {
		t.Fatalf("full flow failed: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called after full flow")
	}
	// Clone phase artifacts: sibling bare repo + checked-out worktree leaf.
	if len(clone.cloneArgs) != 1 || len(clone.worktreeAdd) != 1 {
		t.Fatalf("expected one bare clone + one worktree add, got %d/%d", len(clone.cloneArgs), len(clone.worktreeAdd))
	}
	if _, err := os.Stat(filepath.Join(workdir, ".bare")); err != nil {
		t.Errorf("bare clone should have run (<workdir>/.bare missing): %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, "main", ".git")); err != nil {
		t.Errorf("worktree should be checked out at <workdir>/main (.git missing): %v", err)
	}
	// Dedicated settings scaffolded in the worktree leaf; pi's file absent.
	if _, err := os.Stat(filepath.Join(workdir, "main", "cheasee-settings.json")); err != nil {
		t.Errorf("cheasee-settings.json missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, "main", ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Errorf("init must not scaffold .pi/settings.json: %v", err)
	}
	// The scaffold persists what init already knows: the canonical repo URL
	// (shorthand normalized to https) and the resolved GitHub login, plus the
	// .pi skeleton dirs that pi needs to exist before it starts.
	raw := testutil.ReadCheaseeSettingsRaw(t, filepath.Join(workdir, "main"))
	repo, ok := raw["repository"].(map[string]any)
	if !ok {
		t.Fatal("expected repository section in cheasee-settings.json")
	}
	if repo["url"] != "https://github.com/owner/repo.git" {
		t.Errorf("repository.url = %v, want canonical https://github.com/owner/repo.git", repo["url"])
	}
	if repo["user"] != MockGitHubUser {
		t.Errorf("repository.user = %v, want %q", repo["user"], MockGitHubUser)
	}
	for _, dir := range piSkeletonDirs {
		if _, err := os.Stat(filepath.Join(workdir, "main", ".pi", dir)); err != nil {
			t.Errorf(".pi/%s missing after full flow: %v", dir, err)
		}
	}
	authRaw := readAuthJSON(t)
	if got := authField(t, authRaw, "github_user"); got != MockGitHubUser {
		t.Errorf("auth.json github_user = %q, want %q", got, MockGitHubUser)
	}
	if got := authField(t, authRaw, "github_token"); got != FakeGitHubToken {
		t.Errorf("auth.json github_token = %q, want %q", got, FakeGitHubToken)
	}
}

func TestRunInit_NoGitHubFlag(t *testing.T) {
	// --no-github flag: API-key-only — no clone, no repo-URL prompt, no
	// .pi/settings.json; the dedicated cheasee-settings.json is scaffolded.
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
		d.Workdir = workdir
	}))
	if err != nil {
		t.Fatalf("legacy path should work: %v", err)
	}
	// Dedicated settings scaffolded; pi's own file is not.
	if _, err := os.Stat(filepath.Join(workdir, "cheasee-settings.json")); err != nil {
		t.Errorf("cheasee-settings.json should have been scaffolded: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Errorf("init must not scaffold .pi/settings.json: %v", err)
	}
	// No docker/ extraction into the workdir anymore, no clone.
	if _, err := os.Stat(filepath.Join(workdir, "docker")); !os.IsNotExist(err) {
		t.Errorf("docker/ must not be extracted into the workdir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, ".git")); !os.IsNotExist(err) {
		t.Errorf("--no-github must not clone or create .git: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called on legacy path")
	}
	authRaw := readAuthJSON(t)
	if got := providerKey(t, authRaw, "opencode-go"); got != FakeAPIKey {
		t.Errorf("expected API key %q, got %q", FakeAPIKey, got)
	}
	if got := authField(t, authRaw, "repo_path"); got != workdir {
		t.Errorf("expected repo_path %q, got %q", workdir, got)
	}
	if got := authField(t, authRaw, "api_key"); got != FakeAPIKey {
		t.Errorf("expected flat api_key %q, got %q", FakeAPIKey, got)
	}
	// Legacy path: the repo URL is never threaded, so no repository section —
	// but the .pi skeleton still exists (pi needs the dirs on both paths).
	raw := testutil.ReadCheaseeSettingsRaw(t, workdir)
	if _, ok := raw["repository"]; ok {
		t.Error("--no-github must not write a repository section")
	}
	for _, dir := range piSkeletonDirs {
		if _, err := os.Stat(filepath.Join(workdir, ".pi", dir)); err != nil {
			t.Errorf(".pi/%s missing on legacy path: %v", dir, err)
		}
	}
}

func TestRunInit_ErrUnsupportedFallsBackToLegacy(t *testing.T) {
	// GitHub device flow failing with device.ErrUnsupported must fall back to
	// the legacy API-key path (call site #2): clone still runs and auth.json
	// is written in the legacy patch shape (provider entry + repo_path, no
	// github_token/github_user), with the fallback stderr contract intact.
	clone := stubInitFlow(t)

	_, workdir := newWorkspace(t)
	var err error
	stderr := testutil.CaptureStderr(t, func() {
		err = runInit(context.Background(), initDepsWithRepoURL(t, workdir, func(d *InitDeps) {
			d.APIKey = FakeAPIKey
			d.Ports = InitPorts{Auth: &mockAuthenticator{
				requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
					return nil, device.ErrUnsupported
				},
			}, Catalog: &mockModelCatalog{}}
		}))
	})
	if err != nil {
		t.Fatalf("ErrUnsupported must fall back to legacy, got: %v", err)
	}
	// Fallback stderr contract: both lines stay at the orchestrator call site.
	if !strings.Contains(stderr, "⚠ GitHub OAuth device flow unavailable") {
		t.Errorf("stderr must carry the device-flow-unavailable warning, got:\n%s", stderr)
	}
	if !strings.Contains(stderr, "ℹ Falling back to API-key-only mode") {
		t.Errorf("stderr must carry the fallback notice, got:\n%s", stderr)
	}
	// Clone phase still runs on the fallback path.
	if len(clone.cloneArgs) != 1 || len(clone.worktreeAdd) != 1 {
		t.Fatalf("expected one bare clone + one worktree add, got %d/%d", len(clone.cloneArgs), len(clone.worktreeAdd))
	}
	// Legacy patch shape: provider entry + repo_path, no github fields.
	authRaw := readAuthJSON(t)
	if got := providerKey(t, authRaw, "opencode-go"); got != FakeAPIKey {
		t.Errorf("expected API key %q under provider opencode-go, got %q", FakeAPIKey, got)
	}
	if got := authField(t, authRaw, "repo_path"); got != filepath.Join(workdir, "main") {
		t.Errorf("expected repo_path %q, got %q", filepath.Join(workdir, "main"), got)
	}
	if _, ok := authRaw["github_token"]; ok {
		t.Error("legacy fallback must not write github_token")
	}
	if _, ok := authRaw["github_user"]; ok {
		t.Error("legacy fallback must not write github_user")
	}
}

func TestRunInitLegacyAuth_ReturnsScalars(t *testing.T) {
	// The helper is the shared tail of the two Phase-4 legacy branches in
	// runInit: returns the legacy (provider, apiKey) scalar pair, no
	// repo-path stamping.
	provider, apiKey, err := runInitLegacyAuth(context.Background(), initDeps(t, func(d *InitDeps) {
		d.APIKey = FakeAPIKey
		d.Provider = "opencode-go"
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if apiKey != FakeAPIKey {
		t.Errorf("expected API key %q, got %q", FakeAPIKey, apiKey)
	}
	if provider != "opencode-go" {
		t.Errorf("expected provider %q, got %q", "opencode-go", provider)
	}
}

func TestRunInitLegacyAuth_NoPrintsNoWorkdir(t *testing.T) {
	// The helper is auth-only: it must neither print (the orchestrator owns
	// the ℹ/⚠ stderr contract) nor consume the workdir (the orchestrator
	// stamps repo_path in the phase-7 patch). The error path is a bare
	// return — no seam forces promptAPIKey to fail, so no error-passthrough
	// test is added for this refactor.
	sentinel := t.TempDir()
	var provider, apiKey string
	var err error
	stderr := testutil.CaptureStderr(t, func() {
		provider, apiKey, err = runInitLegacyAuth(context.Background(), initDeps(t, func(d *InitDeps) {
			d.APIKey = FakeAPIKey
			d.Provider = "opencode-go"
			d.Workdir = sentinel
		}))
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stderr != "" {
		t.Errorf("helper must not print to stderr, got: %q", stderr)
	}
	if provider != "opencode-go" || apiKey != FakeAPIKey {
		t.Errorf("expected (opencode-go, %q), got (%q, %q)", FakeAPIKey, provider, apiKey)
	}
	entries, err := os.ReadDir(sentinel)
	if err != nil {
		t.Fatalf("read sentinel dir: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("helper must not write into the workdir, found %d entries", len(entries))
	}
}

func TestRunInit_ContextCancelledMidFlow(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.RedirectConfigHome(t)
	ports := defaultMocks()

	// Override auth with one that respects cancelled context
	ports.Auth = &mockAuthenticator{
		requestCodeFunc: func(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
			return nil, ctx.Err()
		},
	}

	// Cancel right after docker check
	cancel()

	// Interactive with a stubbed repo-URL input and the docker check skipped
	// so the flow reaches the auth phase before erroring on the cancelled ctx.
	err := runInit(ctx, initDeps(t, func(d *InitDeps) {
		d.Ports = ports
		d.NoInput = false
		d.NoDockerCheck = true
		d.InputFn = mockInputFn("owner/repo", nil)
	}))
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
	if !strings.Contains(err.Error(), "GitHub authentication failed") {
		t.Errorf("error should wrap the auth failure, got: %v", err)
	}
	if authJSONExists(t) {
		t.Error("no partial auth.json must be saved when the flow fails")
	}
}
