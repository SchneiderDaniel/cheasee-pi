package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
)

// ──────────────────────────────────────────────
// Mock: Authenticator
// ──────────────────────────────────────────────

type mockAuthenticator struct {
	requestCodeFunc func(ctx context.Context, scopes []string) (*device.CodeResponse, error)
	waitFunc        func(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error)
}

func (m *mockAuthenticator) RequestCode(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
	if m.requestCodeFunc != nil {
		return m.requestCodeFunc(ctx, scopes)
	}
	return &device.CodeResponse{
		UserCode:        "ABCD-1234",
		DeviceCode:      "test-device-code",
		VerificationURI: "https://github.com/login/device",
		Interval:        5,
		ExpiresIn:       900,
	}, nil
}

func (m *mockAuthenticator) Wait(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error) {
	if m.waitFunc != nil {
		return m.waitFunc(ctx, code)
	}
	return &api.AccessToken{Token: FakeGitHubToken}, nil
}

// ──────────────────────────────────────────────
// Mock: GitHubClient
// ──────────────────────────────────────────────

type mockGitHubClient struct {
	getUserFunc    func(ctx context.Context, token string) (string, error)
	createForkFunc func(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error)
	waitForkFunc   func(ctx context.Context, token, owner, repo string) error
}

func (m *mockGitHubClient) GetAuthenticatedUser(ctx context.Context, token string) (string, error) {
	if m.getUserFunc != nil {
		return m.getUserFunc(ctx, token)
	}
	return "testuser", nil
}

func (m *mockGitHubClient) CreateFork(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error) {
	if m.createForkFunc != nil {
		return m.createForkFunc(ctx, token, sourceOwner, sourceRepo)
	}
	return "testuser/cheasee-pi", nil
}

func (m *mockGitHubClient) WaitForkReady(ctx context.Context, token, owner, repo string) error {
	if m.waitForkFunc != nil {
		return m.waitForkFunc(ctx, token, owner, repo)
	}
	return nil
}

// ──────────────────────────────────────────────
// Mock: ConfirmFn
// ──────────────────────────────────────────────

// mockConfirmFn returns a confirm function that returns the given result.
// mockConfirmFn creates a mock confirm function.
// If exceptions are provided, any question whose title contains one of the
// exception substrings returns !result instead of result.
func mockConfirmFn(result bool, err error, exceptions ...string) func(string) (bool, error) {
	return func(title string) (bool, error) {
		for _, exc := range exceptions {
			if strings.Contains(title, exc) {
				return !result, err
			}
		}
		return result, err
	}
}

// ──────────────────────────────────────────────
// Mock: InputFn
// ──────────────────────────────────────────────

// mockInputFn returns an input function that returns the given result.
func mockInputFn(result string, err error) func(title, placeholder string) (string, error) {
	return func(title, placeholder string) (string, error) {
		return result, err
	}
}

// ──────────────────────────────────────────────
// Compile-time interface checks
// ──────────────────────────────────────────────

var (
	_ Authenticator = (*mockAuthenticator)(nil)
	_ GitHubClient  = (*mockGitHubClient)(nil)
)

// ──────────────────────────────────────────────
// Mock: cmdIface
// ──────────────────────────────────────────────

type mockCmd struct {
	outputFn   func() ([]byte, error)
	combinedFn func() ([]byte, error)
	runFn      func() error
	// Captured Set* config, for callers that configure the command
	dir    string
	env    []string
	stdout interface{ Write([]byte) (int, error) }
	stderr interface{ Write([]byte) (int, error) }
}

func (m *mockCmd) Output() ([]byte, error) {
	if m.outputFn != nil {
		return m.outputFn()
	}
	return nil, nil
}

func (m *mockCmd) CombinedOutput() ([]byte, error) {
	if m.combinedFn != nil {
		return m.combinedFn()
	}
	return nil, nil
}

func (m *mockCmd) Run() error {
	if m.runFn != nil {
		return m.runFn()
	}
	return nil
}

func (m *mockCmd) SetDir(d string)       { m.dir = d }
func (m *mockCmd) SetEnv(e []string)     { m.env = e }
func (m *mockCmd) SetStdout(w io.Writer) { m.stdout = w }
func (m *mockCmd) SetStderr(w io.Writer) { m.stderr = w }

// ──────────────────────────────────────────────
// Seam stubs (docker/git CLI tests)
// ──────────────────────────────────────────────

// stubRunCommandContext replaces the runCommandContext seam for the duration
// of the test. Serialized (no t.Parallel) — package-var swap is race-free
// only under serial execution.
func stubRunCommandContext(t *testing.T, fn func(context.Context, string, ...string) runner) {
	t.Helper()
	saved := runCommandContext
	runCommandContext = fn
	t.Cleanup(func() { runCommandContext = saved })
}

// stubExecCommand replaces the execCommand seam for the duration of the test.
func stubExecCommand(t *testing.T, fn func(string, ...string) cmdIface) {
	t.Helper()
	saved := execCommand
	execCommand = fn
	t.Cleanup(func() { execCommand = saved })
}

// stubLookPath replaces the lookPath seam for the duration of the test.
func stubLookPath(t *testing.T, fn func(string) (string, error)) {
	t.Helper()
	saved := lookPath
	lookPath = fn
	t.Cleanup(func() { lookPath = saved })
}

// stubDockerCheck stubs the docker seams. daemonErr, when non-nil, makes
// `docker info` fail; version is the docker version output (versionErr wins
// over version when set).
func stubDockerCheck(t *testing.T, daemonErr error, version string, versionErr error) {
	t.Helper()
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	stubRunCommandContext(t, func(_ context.Context, _ string, arg ...string) runner {
		if len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) {
				if versionErr != nil {
					return nil, versionErr
				}
				return []byte(version), nil
			}}
		}
		return &mockCmd{runFn: func() error { return daemonErr }}
	})
}

// ──────────────────────────────────────────────
// Renderer + scaffold helpers (package-main value types)
// ──────────────────────────────────────────────

// testGitIdentityConfig is the hermetic git identity used by init tests.
const testGitIdentityConfig = "[user]\n\tname = Test User\n\temail = test@example.com\n"

// ScaffoldSettings renders the embedded settings template into a fresh
// workdir and returns the workdir.
func ScaffoldSettings(t *testing.T, vals TemplateSettingsValues) string {
	t.Helper()
	workdir := t.TempDir()
	if err := NewSettingsScaffold().Scaffold(context.Background(), workdir, vals); err != nil {
		t.Fatalf("Scaffold failed: %v", err)
	}
	return workdir
}

// RenderEnv renders docker/.env from vals and returns the file content.
func RenderEnv(t *testing.T, vals EnvValues) string {
	t.Helper()
	dest := filepath.Join(t.TempDir(), "docker", ".env")
	if err := NewEnvRenderer().Render(context.Background(), dest, vals); err != nil {
		t.Fatalf("Render failed: %v", err)
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	return string(data)
}

// ──────────────────────────────────────────────
// Auth/config seeding + package-var mutation
// ──────────────────────────────────────────────

// defaultMocks returns a set of working mock implementations for the genuine
// seam ports (network/external-service boundaries). In-process adapters
// (probe, extract, env, scaffold, remover, uid, git identity) are real.
func defaultMocks() InitPorts {
	return InitPorts{
		Auth: &mockAuthenticator{},
		GitHub: &mockGitHubClient{
			getUserFunc: func(ctx context.Context, token string) (string, error) {
				return "testuser", nil
			},
			createForkFunc: func(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error) {
				return "testuser/cheasee-pi", nil
			},
			waitForkFunc: func(ctx context.Context, token, owner, repo string) error {
				return nil
			},
		},
	}
}

// seedAuth writes auth.json providers into the current config home. Call
// testutil.RedirectConfigHome or pinPassthroughEnv first.
func seedAuth(t *testing.T, providers map[string]string) {
	t.Helper()
	cfg := &fileRepository{}
	for name, key := range providers {
		if err := cfg.AddProvider(context.Background(), name, key); err != nil {
			t.Fatalf("seed auth.json: %v", err)
		}
	}
}

// withInitProvider sets the package-level init provider for the test duration.
func withInitProvider(t *testing.T, name string) {
	t.Helper()
	saved := initProvider
	initProvider = name
	t.Cleanup(func() { initProvider = saved })
}

// withAuthListWorkdir sets the package-level auth list workdir for the test duration.
func withAuthListWorkdir(t *testing.T, workdir string) {
	t.Helper()
	saved := authListWorkdir
	authListWorkdir = workdir
	t.Cleanup(func() { authListWorkdir = saved })
}

// pinPassthroughEnv makes buildEnvFlags hermetic: fresh XDG_CONFIG_HOME,
// every passthrough env name cleared, and PATH pointing at a failing gh
// binary so GH_TOKEN extraction can't leak the host's real token into the map.
func pinPassthroughEnv(t *testing.T) string {
	t.Helper()
	xdg := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", xdg)
	for _, name := range AllEnvVarNames() {
		t.Setenv(name, "")
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	return xdg
}

// marshalAuth JSON-marshals auth, failing the test on error.
func marshalAuth(t *testing.T, auth *Auth) []byte {
	t.Helper()
	data, err := json.Marshal(auth)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}
	return data
}

// initDeps builds a runInit dependency set with the common test defaults:
// mocked ports, docker check enabled, GitHub flow enabled, no input, prompt
// fork, fresh workdir, confirming+empty-input fns. Override any field via
// opts, e.g. initDeps(t, func(d *InitDeps) { d.NoGitHub = true }).
func initDeps(t *testing.T, opts ...func(*InitDeps)) InitDeps {
	t.Helper()
	deps := InitDeps{
		Ports:         defaultMocks(),
		NoDockerCheck: false,
		NoGitHub:      false,
		NoInput:       true,
		SourceFork:    SourceForkInput{Mode: ModePromptFork},
		Workdir:       t.TempDir(),
		ConfirmFn:     mockConfirmFn(true, nil),
		InputFn:       mockInputFn("", nil),
	}
	for _, opt := range opts {
		opt(&deps)
	}
	return deps
}
