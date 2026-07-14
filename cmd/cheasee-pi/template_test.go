package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// EnvRenderer adapter tests
// ──────────────────────────────────────────────

func TestEnvRenderer_WritesCorrectLines(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "docker", ".env")

	r := &flatEnvRenderer{}
	err := r.Render(context.Background(), dest, EnvValues{
		HostUID:  "1000",
		HostGID:  "1001",
		GitName:  "Test User",
		GitEmail: "test@example.com",
	})
	if err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "HOST_UID=1000") {
		t.Errorf("missing HOST_UID: %s", content)
	}
	if !strings.Contains(content, "HOST_GID=1001") {
		t.Errorf("missing HOST_GID: %s", content)
	}
	if !strings.Contains(content, "HOST_GIT_NAME=") {
		t.Errorf("missing HOST_GIT_NAME: %s", content)
	}
	if !strings.Contains(content, "HOST_GIT_EMAIL=test@example.com") {
		t.Errorf("missing HOST_GIT_EMAIL: %s", content)
	}
}

func TestEnvRenderer_ShellEscapesWhitespace(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "docker", ".env")

	r := &flatEnvRenderer{}
	err := r.Render(context.Background(), dest, EnvValues{
		HostUID:  "1000",
		HostGID:  "1001",
		GitName:  "User With Spaces",
		GitEmail: "test@example.com",
	})
	if err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	content := string(data)

	// Value with spaces should be quoted
	if !strings.Contains(content, `HOST_GIT_NAME="User With Spaces"`) {
		t.Errorf("expected quoted git name: %s", content)
	}
}

func TestEnvRenderer_CreatesDir(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "deep", "nested", "docker", ".env")

	r := &flatEnvRenderer{}
	err := r.Render(context.Background(), dest, EnvValues{
		HostUID:  "1000",
		HostGID:  "1001",
		GitName:  "Test",
		GitEmail: "test@test.com",
	})
	if err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	if _, err := os.Stat(dest); os.IsNotExist(err) {
		t.Error("expected .env file to exist")
	}
}

func TestEnvRenderer_RejectsEmptyUID(t *testing.T) {
	r := &flatEnvRenderer{}
	err := r.Render(context.Background(), "/tmp/.env", EnvValues{
		HostUID:  "",
		HostGID:  "1001",
		GitName:  "Test",
		GitEmail: "test@test.com",
	})
	if err == nil {
		t.Fatal("expected error for empty UID")
	}
	if !strings.Contains(err.Error(), "HOST_UID") {
		t.Errorf("error should mention HOST_UID: %v", err)
	}
}

func TestEnvRenderer_RejectsEmptyGID(t *testing.T) {
	r := &flatEnvRenderer{}
	err := r.Render(context.Background(), "/tmp/.env", EnvValues{
		HostUID:  "1000",
		HostGID:  "",
		GitName:  "Test",
		GitEmail: "test@test.com",
	})
	if err == nil {
		t.Fatal("expected error for empty GID")
	}
	if !strings.Contains(err.Error(), "HOST_GID") {
		t.Errorf("error should mention HOST_GID: %v", err)
	}
}

// ──────────────────────────────────────────────
// ShellEscape tests
// ──────────────────────────────────────────────

func TestShellEscape_NoEscape(t *testing.T) {
	result := shellEscape("simple")
	if result != "simple" {
		t.Errorf("expected 'simple', got %q", result)
	}
}

func TestShellEscape_WithSpaces(t *testing.T) {
	result := shellEscape("User Name")
	if result != `"User Name"` {
		t.Errorf("expected quoted, got %q", result)
	}
}

func TestShellEscape_WithSpecialChars(t *testing.T) {
	result := shellEscape("test$VAR")
	if result != `"test$VAR"` {
		t.Errorf("expected quoted with $, got %q", result)
	}
}

// ──────────────────────────────────────────────
// UIDResolver adapter tests
// ──────────────────────────────────────────────

func TestOSUIDResolver_ReturnsValidValues(t *testing.T) {
	// On a system with os/user.Current() working, returns real UID/GID.
	// On a system where it fails, falls back to env or id command.
	r := &osUIDResolver{}
	uid, gid, err := r.Current()
	if err != nil {
		t.Fatalf("Current() failed: %v", err)
	}
	if uid == "" || gid == "" {
		t.Errorf("expected non-empty uid/gid, got %q/%q", uid, gid)
	}
}

// ──────────────────────────────────────────────
// WorkingDirProbe adapter tests
// ──────────────────────────────────────────────

func TestOSWorkingDirProbe_Empty(t *testing.T) {
	dir := t.TempDir()
	p := &osWorkingDirProbe{}
	state, err := p.Inspect(dir)
	if err != nil {
		t.Fatalf("Inspect failed: %v", err)
	}
	if state != WorkdirEmpty {
		t.Errorf("expected WorkdirEmpty, got %s", state)
	}
}

func TestOSWorkingDirProbe_HasRepo(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".git"), 0755)

	p := &osWorkingDirProbe{}
	state, err := p.Inspect(dir)
	if err != nil {
		t.Fatalf("Inspect failed: %v", err)
	}
	if state != WorkdirHasRepo {
		t.Errorf("expected WorkdirHasRepo (%d), got %s (%d)", WorkdirHasRepo, state, state)
	}
}

func TestOSWorkingDirProbe_HasCompose(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("version: '3'\n"), 0644)

	p := &osWorkingDirProbe{}
	state, err := p.Inspect(dir)
	if err != nil {
		t.Fatalf("Inspect failed: %v", err)
	}
	if state != WorkdirHasCompose {
		t.Errorf("expected WorkdirHasCompose (%d), got %s (%d)", WorkdirHasCompose, state, state)
	}
}

func TestOSWorkingDirProbe_Complete(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".git"), 0755)
	os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("version: '3'\n"), 0644)

	p := &osWorkingDirProbe{}
	state, err := p.Inspect(dir)
	if err != nil {
		t.Fatalf("Inspect failed: %v", err)
	}
	if state != WorkdirComplete {
		t.Errorf("expected WorkdirComplete (%d), got %s (%d)", WorkdirComplete, state, state)
	}
}

// ──────────────────────────────────────────────
// WorkdirState tests (entity)
// ──────────────────────────────────────────────

func TestWorkdirState_IsComplete(t *testing.T) {
	if WorkdirEmpty.IsComplete() {
		t.Error("WorkdirEmpty should not be complete")
	}
	if WorkdirHasRepo.IsComplete() {
		t.Error("WorkdirHasRepo should not be complete")
	}
	if WorkdirHasCompose.IsComplete() {
		t.Error("WorkdirHasCompose should not be complete")
	}
	if !WorkdirComplete.IsComplete() {
		t.Error("WorkdirComplete should be complete")
	}
}

func TestWorkdirState_String(t *testing.T) {
	if WorkdirEmpty.String() != "empty" {
		t.Errorf("expected 'empty', got %q", WorkdirEmpty.String())
	}
	if WorkdirComplete.String() != "complete" {
		t.Errorf("expected 'complete', got %q", WorkdirComplete.String())
	}
}

// ──────────────────────────────────────────────
// EnvValues validation tests
// ──────────────────────────────────────────────

func TestEnvValues_Validate(t *testing.T) {
	tests := []struct {
		name    string
		vals    EnvValues
		wantErr bool
	}{
		{"valid", EnvValues{HostUID: "1000", HostGID: "1000"}, false},
		{"empty uid", EnvValues{HostUID: "", HostGID: "1000"}, true},
		{"empty gid", EnvValues{HostUID: "1000", HostGID: ""}, true},
		{"both empty", EnvValues{HostUID: "", HostGID: ""}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.vals.Validate()
			if tt.wantErr && err == nil {
				t.Error("expected error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
}

// ──────────────────────────────────────────────
// GitIdentity adapter test
// ──────────────────────────────────────────────

func TestOSGitIdentity_Lookup(t *testing.T) {
	// This test relies on git config being available on the system.
	// It's a lightweight smoke test.
	id := &osGitIdentity{}
	name, email, err := id.Lookup()
	if err != nil {
		// git binary might not exist, that's OK — the adapter handles it
		t.Logf("Git lookup (non-fatal if git not configured): name=%q email=%q err=%v", name, email, err)
	}
	// No assertion on values — depends on test environment
}
