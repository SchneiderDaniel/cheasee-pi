// Package testutil provides pure scaffolding shared by cmd/cheasee-pi tests:
// stderr capture, hermetic fs/env fixtures, settings/env file IO, and a
// parameterized cobra runner. It touches stdlib + cobra only — package-main
// state (seam vars, package-level commands, renderer value types) stays in
// the in-package helpers_test.go.
package testutil

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// CaptureStderr runs fn and returns any output written to os.Stderr. It
// restores os.Stderr even when fn panics. Serialized (no t.Parallel) because
// os.Stderr is process-global.
func CaptureStderr(t *testing.T, fn func()) string {
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
	defer func() {
		// Close + restore on the panic path too; harmless double-close after
		// the normal path already closed w.
		w.Close()
		os.Stderr = orig
	}()
	fn()
	// Close the write end so the reader goroutine sees EOF.
	w.Close()
	os.Stderr = orig
	return <-out
}

// ReadEnvFile reads docker/.env and returns its KEY=VALUE lines as a map,
// stripping surrounding quotes from values.
func ReadEnvFile(t *testing.T, workdir string) map[string]string {
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

// ReadSettingsRaw reads .pi/settings.json and returns it as a map.
func ReadSettingsRaw(t *testing.T, workdir string) map[string]any {
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

// WriteSettingsFile writes .pi/settings.json, creating parent dirs.
func WriteSettingsFile(t *testing.T, workdir, content string) {
	t.Helper()
	path := filepath.Join(workdir, ".pi", "settings.json")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

// WriteCheaseeSettingsFile writes cheasee-settings.json at the workspace root.
func WriteCheaseeSettingsFile(t *testing.T, workdir, content string) {
	t.Helper()
	path := filepath.Join(workdir, "cheasee-settings.json")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

// ReadCheaseeSettingsRaw reads cheasee-settings.json and returns it as a map.
func ReadCheaseeSettingsRaw(t *testing.T, workdir string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatalf("read cheasee-settings.json: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("cheasee-settings.json is not valid JSON: %v", err)
	}
	return raw
}

// SetGitConfig points git config lookups at a hermetic temp config file
// containing content (system config disabled). Skips when git is absent.
// Serialized (no t.Parallel) because t.Setenv is process-wide.
func SetGitConfig(t *testing.T, content string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	cfg := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(cfg, []byte(content), 0644); err != nil {
		t.Fatalf("write gitconfig: %v", err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", cfg)
	t.Setenv("GIT_CONFIG_SYSTEM", "/dev/null")
}

// RedirectConfigHome points the auth config dir at a fresh temp dir so no
// test touches the real $HOME/.config. It returns the new config home.
// Serialized (no t.Parallel) because t.Setenv is process-wide.
func RedirectConfigHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	return dir
}

// RunCobra executes cmd with args, capturing stdout. The command must be
// passed as a parameter — never a package-global command mutated from this
// package. Serialized (no t.Parallel): RunCobra mutates the command.
func RunCobra(t *testing.T, cmd *cobra.Command, args ...string) (string, error) {
	t.Helper()
	var out, errOut bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&errOut)
	cmd.SetArgs(args)
	_, err := cmd.ExecuteC()
	return out.String(), err
}
