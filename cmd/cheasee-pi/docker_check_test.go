package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestCheckResult_ZeroValue(t *testing.T) {
	var r CheckResult
	if r.Installed {
		t.Error("zero-value CheckResult.Installed should be false")
	}
	if r.Running {
		t.Error("zero-value CheckResult.Running should be false")
	}
}

func TestDockerCheck_NotInstalled(t *testing.T) {
	stubLookPath(t, func(_ string) (string, error) { return "", fmt.Errorf("executable not found in $PATH") })

	res, err := dockerCheck(context.Background(), dockerCheckTimeout)
	if err != nil {
		t.Fatalf("dockerCheck returned error: %v", err)
	}
	if res.Installed {
		t.Error("Installed should be false")
	}
	if res.Running {
		t.Error("Running should be false")
	}
	if !strings.Contains(res.Err.Error(), "docker not found") {
		t.Errorf("Err should mention docker not found: %v", res.Err)
	}
}

func TestDockerCheck_DaemonNotRunning(t *testing.T) {
	stubDockerCheck(t, fmt.Errorf("Cannot connect to the Docker daemon"), "", nil)

	res, err := dockerCheck(context.Background(), dockerCheckTimeout)
	if err != nil {
		t.Fatalf("dockerCheck returned error: %v", err)
	}
	if !res.Installed {
		t.Error("Installed should be true")
	}
	if res.Running {
		t.Error("Running should be false")
	}
	if !strings.Contains(res.Err.Error(), "Docker daemon not running") {
		t.Errorf("Err should mention daemon not running: %v", res.Err)
	}
}

func TestDockerCheck_VersionOutputError(t *testing.T) {
	stubDockerCheck(t, nil, "", fmt.Errorf("connection refused"))

	res, err := dockerCheck(context.Background(), dockerCheckTimeout)
	if err != nil {
		t.Fatalf("dockerCheck returned error: %v", err)
	}
	if !strings.Contains(res.Err.Error(), "failed to get Docker Engine version") {
		t.Errorf("Err should mention version fetch failure: %v", res.Err)
	}
}

func TestDockerCheck_Healthy(t *testing.T) {
	stubDockerCheck(t, nil, "25.0.0-rc1", nil)

	res, err := dockerCheck(context.Background(), dockerCheckTimeout)
	if err != nil {
		t.Fatalf("dockerCheck returned error: %v", err)
	}
	if !res.Installed || !res.Running {
		t.Errorf("expected installed+running, got %+v", res)
	}
	if res.Version != "25.0.0-rc1" {
		t.Errorf("expected Version 25.0.0-rc1, got %q", res.Version)
	}
	if res.Err != nil {
		t.Errorf("expected nil Err, got %v", res.Err)
	}
}

func TestDockerCheck_ArgsCaptured(t *testing.T) {
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	var infoArgs, versionArgs []string
	stubRunCommandContext(t, func(_ context.Context, _ string, arg ...string) runner {
		if len(arg) > 0 && arg[0] == "info" {
			infoArgs = arg
			return &mockCmd{}
		}
		versionArgs = arg
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("24.0.9"), nil }}
	})

	if _, err := dockerCheck(context.Background(), dockerCheckTimeout); err != nil {
		t.Fatalf("dockerCheck returned error: %v", err)
	}
	if strings.Join(infoArgs, " ") != "info" {
		t.Errorf("Run() should get (docker, info), got %v", infoArgs)
	}
	wantVersion := strings.Join([]string{"version", "--format", "{{.Server.Version}}"}, " ")
	if strings.Join(versionArgs, " ") != wantVersion {
		t.Errorf("Output() should get %q, got %v", wantVersion, versionArgs)
	}
}

func TestDockerCheck_CtxCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	res, err := dockerCheck(ctx, dockerCheckTimeout)
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
	if !strings.Contains(err.Error(), "context") {
		t.Errorf("error should mention context: %v", err)
	}
	if res != nil {
		t.Errorf("expected nil result for cancelled context, got %+v", res)
	}
}
