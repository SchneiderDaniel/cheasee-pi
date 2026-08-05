package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

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

// setGitIdentity points git config lookups at a hermetic temp config file
// containing user.name/user.email, so real osGitIdentity lookups are
// deterministic and never fall through to interactive prompts. Serialized
// (no t.Parallel) because t.Setenv is process-wide.
func setGitIdentity(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	cfg := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(cfg, []byte("[user]\n\tname = Test User\n\temail = test@example.com\n"), 0644); err != nil {
		t.Fatalf("write gitconfig: %v", err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", cfg)
	t.Setenv("GIT_CONFIG_SYSTEM", "/dev/null")
}

// unsetGitIdentity points git config lookups at an empty file (no identity),
// the deterministic no-identity state for fallback tests.
func unsetGitIdentity(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	cfg := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(cfg, nil, 0644); err != nil {
		t.Fatalf("write gitconfig: %v", err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", cfg)
	t.Setenv("GIT_CONFIG_SYSTEM", "/dev/null")
}

// ──────────────────────────────────────────────
// Seam stubs for docker/git CLI tests
// ──────────────────────────────────────────────

// stubDockerLookPath makes the docker binary appear installed until test end.
func stubDockerLookPath(t *testing.T) {
	t.Helper()
	saved := lookPath
	lookPath = func(_ string) (string, error) { return "/usr/bin/docker", nil }
	t.Cleanup(func() { lookPath = saved })
}

// stubDockerCheck stubs the docker seams. daemonErr, when non-nil, makes
// `docker info` fail; version is the docker version output (versionErr wins
// over version when set).
func stubDockerCheck(t *testing.T, daemonErr error, version string, versionErr error) {
	t.Helper()
	stubDockerLookPath(t)
	saved := runCommandContext
	runCommandContext = func(_ context.Context, _ string, arg ...string) runner {
		if len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) {
				if versionErr != nil {
					return nil, versionErr
				}
				return []byte(version), nil
			}}
		}
		return &mockCmd{runFn: func() error { return daemonErr }}
	}
	t.Cleanup(func() { runCommandContext = saved })
}

// redirectConfigDir points the auth config dir at a fresh temp dir so no test
// touches the real $HOME/.config.
func redirectConfigDir(t *testing.T) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
}

// authJSONExists reports whether auth.json was written to the config dir.
func authJSONExists(t *testing.T) bool {
	t.Helper()
	cfg := &fileRepository{}
	p, err := cfg.Path()
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

// loadAuthJSON reads the saved auth.json back via fileRepository.
func loadAuthJSON(t *testing.T) *Auth {
	t.Helper()
	cfg := &fileRepository{}
	auth, err := cfg.Load(context.Background())
	if err != nil {
		t.Fatalf("load auth.json: %v", err)
	}
	return auth
}

// readEnvFile reads docker/.env and returns its KEY=VALUE lines as a map.
func readEnvFile(t *testing.T, workdir string) map[string]string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(workdir, "docker", ".env"))
	if err != nil {
		t.Fatalf("read docker/.env: %v", err)
	}
	vals := make(map[string]string)
	for _, line := range strings.Split(string(data), "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			vals[k] = strings.Trim(v, "\"")
		}
	}
	return vals
}

// readSettingsFile reads .pi/settings.json and returns it as a map.
func readSettingsFile(t *testing.T, workdir string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(workdir, ".pi", "settings.json"))
	if err != nil {
		t.Fatalf("read .pi/settings.json: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("settings.json is not valid JSON: %v", err)
	}
	return raw
}

// seedCloneFixture pre-seeds a workdir with a .git marker (so the clone
// refusal check passes and clone is skipped), a .initremove manifest listing
// test.md and .github/, both present on disk, and a README.md control file
// that is not listed and must survive cleanup.
func seedCloneFixture(t *testing.T, workdir string) {
	t.Helper()
	os.MkdirAll(filepath.Join(workdir, ".git"), 0755)
	if err := os.WriteFile(filepath.Join(workdir, ".initremove"), []byte("test.md\n.github/\n"), 0644); err != nil {
		t.Fatalf("write .initremove: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workdir, "test.md"), []byte("data"), 0644); err != nil {
		t.Fatalf("write test.md: %v", err)
	}
	os.MkdirAll(filepath.Join(workdir, ".github", "workflows"), 0755)
	if err := os.WriteFile(filepath.Join(workdir, "README.md"), []byte("# repo\n"), 0644); err != nil {
		t.Fatalf("write README.md: %v", err)
	}
}

// captureStderr runs fn and returns any output written to stderr.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	orig := os.Stderr
	os.Stderr = w

	out := make(chan string, 1)
	go func() {
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(r)
		out <- buf.String()
	}()

	fn()

	os.Stderr = orig
	w.Close()
	return <-out
}
