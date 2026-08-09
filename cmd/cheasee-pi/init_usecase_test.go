package main

import (
	"context"
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInitUseCase_DockerNotInstalled(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubLookPath(t, func(_ string) (string, error) { return "", fmt.Errorf("executable not found in $PATH") })

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.NoGitHub = true }))
	if err == nil {
		t.Fatal("expected error when Docker not installed")
	}
	if !strings.Contains(err.Error(), "Docker is not installed") {
		t.Errorf("error should mention Docker is not installed: %v", err)
	}
	if authJSONExists(t) {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerNotRunning(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, fmt.Errorf("Cannot connect to the Docker daemon"), "", nil)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.NoGitHub = true }))
	if err == nil {
		t.Fatal("expected error when Docker not running")
	}
	if !strings.Contains(err.Error(), "not running") {
		t.Errorf("error should mention Docker not running: %v", err)
	}
	if authJSONExists(t) {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerVersionTooOld(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "23.0.0", nil)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.NoGitHub = true }))
	if err == nil {
		t.Fatal("expected error when Docker version too old")
	}
	if !strings.Contains(err.Error(), "Docker") {
		t.Errorf("error should mention Docker: %v", err)
	}
	if authJSONExists(t) {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerCheckReturnsErr(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "", fmt.Errorf("version check failed"))

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.NoGitHub = true }))
	if err == nil {
		t.Fatal("expected error when Docker version fetch fails")
	}
	if !strings.Contains(err.Error(), "Docker version check") {
		t.Errorf("error should mention Docker version check: %v", err)
	}
}

func TestInitUseCase_NoDockerCheckFlag(t *testing.T) {
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.NoDockerCheck = true
		d.APIKey = FakeAPIKey
	}))
	if err != nil {
		t.Fatalf("unexpected error with --no-docker-check: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called when --no-docker-check is set")
	}
	if got := loadAuthJSON(t).APIKey; got != FakeAPIKey {
		t.Errorf("expected saved key %q, got %q", FakeAPIKey, got)
	}
}

func TestInitUseCase_HappyPathWithAPIKeyFlag(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err != nil {
		t.Fatalf("unexpected error on happy path: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called on happy path")
	}
	if got := loadAuthJSON(t).APIKey; got != FakeAPIKey {
		t.Errorf("expected API key %q, got %q", FakeAPIKey, got)
	}
}

func TestInitUseCase_ConfigSaveError(t *testing.T) {
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	// Block the config dir path with a regular file so MkdirAll fails
	// deterministically (real file I/O, no mock error injection).
	dir := testutil.RedirectConfigHome(t)
	if err := os.WriteFile(filepath.Join(dir, "cheasee-pi"), []byte("block"), 0644); err != nil {
		t.Fatalf("block config dir: %v", err)
	}

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err == nil {
		t.Fatal("expected error when Save fails")
	}
	if !strings.Contains(err.Error(), "save auth config") {
		t.Errorf("error should wrap with 'save auth config': %v", err)
	}
}

func TestInitUseCase_ContextCancelled(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled

	err := runInit(ctx, initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err == nil {
		t.Fatal("expected error with cancelled context")
	}
	if !strings.Contains(err.Error(), "context") {
		t.Errorf("error should mention context cancellation: %v", err)
	}
}

func TestInitProbe_Empty(t *testing.T) {
	called := false
	confirm := func(title string) (bool, error) {
		called = true
		return true, nil
	}
	proceed, err := runInitProbe(context.Background(), t.TempDir(), confirm, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !proceed {
		t.Error("expected to proceed for empty dir")
	}
	if called {
		t.Error("confirmFn should not be called for an empty dir")
	}
}

func TestInitProbe_NoInputProceeds(t *testing.T) {
	// Non-interactive mode proceeds even with existing setup markers.
	called := false
	confirm := func(title string) (bool, error) {
		called = true
		return true, nil
	}
	dir := t.TempDir()
	testutil.WriteSettingsFile(t, dir, `{"defaultProvider": "openai"}`)

	proceed, err := runInitProbe(context.Background(), dir, confirm, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !proceed {
		t.Error("expected to proceed when noInput is true")
	}
	if called {
		t.Error("confirmFn should not be called when noInput is true")
	}
}

func TestInitProbe_PromptsWhenSettingsExist(t *testing.T) {
	dir := t.TempDir()
	testutil.WriteSettingsFile(t, dir, `{"defaultProvider": "openai"}`)

	var gotTitle string
	confirm := func(title string) (bool, error) {
		gotTitle = title
		return true, nil
	}
	proceed, err := runInitProbe(context.Background(), dir, confirm, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !proceed {
		t.Error("expected to proceed when user accepts")
	}
	if gotTitle != "Existing .pi/settings.json detected. Re-apply configuration?" {
		t.Errorf("expected re-apply confirm title, got %q", gotTitle)
	}
}

func TestInitProbe_UserDeclines(t *testing.T) {
	dir := t.TempDir()
	testutil.WriteSettingsFile(t, dir, `{"defaultProvider": "openai"}`)

	proceed, err := runInitProbe(context.Background(), dir, mockConfirmFn(false, nil), false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if proceed {
		t.Error("expected not to proceed when user declines")
	}
}
