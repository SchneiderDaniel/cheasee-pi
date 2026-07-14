package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestInitUseCase_DockerNotInstalled(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: false,
			Running:   false,
			Err:       fmt.Errorf("docker not found"),
		},
	}
	mockCfg := &mockRepository{}

	err := runInit(context.Background(), mockDocker, mockCfg, "", false)
	if err == nil {
		t.Fatal("expected error when Docker not installed")
	}
	if !strings.Contains(err.Error(), "Docker is not installed") {
		t.Errorf("error should mention Docker is not installed: %v", err)
	}
	if mockCfg.saved {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerNotRunning(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: true,
			Running:   false,
			Err:       fmt.Errorf("Docker daemon not running"),
		},
	}
	mockCfg := &mockRepository{}

	err := runInit(context.Background(), mockDocker, mockCfg, "", false)
	if err == nil {
		t.Fatal("expected error when Docker not running")
	}
	if !strings.Contains(err.Error(), "not running") {
		t.Errorf("error should mention Docker not running: %v", err)
	}
	if mockCfg.saved {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerVersionTooOld(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: true,
			Running:   true,
			Version:   "23.0.0",
			Err:       fmt.Errorf("Docker Engine 23.0.0 is too old, need >= 24.0.0"),
		},
	}
	mockCfg := &mockRepository{}

	err := runInit(context.Background(), mockDocker, mockCfg, "", false)
	if err == nil {
		t.Fatal("expected error when Docker version too old")
	}
	if !strings.Contains(err.Error(), "Docker") {
		t.Errorf("error should mention Docker: %v", err)
	}
	if mockCfg.saved {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerCheckReturnsErr(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: true,
			Running:   true,
			Version:   "24.0.9",
			Err:       fmt.Errorf("version check failed"),
		},
	}
	mockCfg := &mockRepository{}

	err := runInit(context.Background(), mockDocker, mockCfg, "", false)
	if err == nil {
		t.Fatal("expected error when Docker CheckResult.Err is set")
	}
}

func TestInitUseCase_NoDockerCheckFlag(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: false,
		},
	}
	mockCfg := &mockRepository{}

	err := runInit(context.Background(), mockDocker, mockCfg, "sk-abc123", true)
	if err != nil {
		t.Fatalf("unexpected error with --no-docker-check: %v", err)
	}
	if !mockCfg.saved {
		t.Error("Save should be called when --no-docker-check is set")
	}
	if mockCfg.savedKey != "sk-abc123" {
		t.Errorf("expected saved key 'sk-abc123', got %q", mockCfg.savedKey)
	}
}

func TestInitUseCase_HappyPathWithAPIKeyFlag(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: true,
			Running:   true,
			Version:   "24.0.9",
		},
	}
	mockCfg := &mockRepository{}

	err := runInit(context.Background(), mockDocker, mockCfg, "sk-abc123", false)
	if err != nil {
		t.Fatalf("unexpected error on happy path: %v", err)
	}
	if !mockCfg.saved {
		t.Error("Save should be called on happy path")
	}
	if mockCfg.savedKey != "sk-abc123" {
		t.Errorf("expected API key 'sk-abc123', got %q", mockCfg.savedKey)
	}
}

func TestInitUseCase_ConfigSaveError(t *testing.T) {
	mockDocker := &mockDockerChecker{
		result: &CheckResult{
			Installed: true,
			Running:   true,
			Version:   "24.0.9",
		},
	}
	mockCfg := &mockRepository{saveErr: fmt.Errorf("disk full")}

	err := runInit(context.Background(), mockDocker, mockCfg, "sk-abc123", false)
	if err == nil {
		t.Fatal("expected error when Save fails")
	}
	if !strings.Contains(err.Error(), "disk full") {
		t.Errorf("error should propagate Save error: %v", err)
	}
}

func TestInitUseCase_ContextCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled

	mockDocker := &mockCheckerCtx{orig: &mockDockerChecker{
		result: &CheckResult{Installed: true, Running: true, Version: "24.0.9"},
	}}
	mockCfg := &mockRepository{}

	err := runInit(ctx, mockDocker, mockCfg, "sk-abc123", false)
	if err == nil {
		t.Fatal("expected error with cancelled context")
	}
	if !strings.Contains(err.Error(), "context") {
		t.Errorf("error should mention context cancellation: %v", err)
	}
}
