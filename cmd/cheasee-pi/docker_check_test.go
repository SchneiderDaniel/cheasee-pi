package main

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"golang.org/x/mod/semver"
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

func TestDockerVersionParsing(t *testing.T) {
	tests := []struct {
		name      string
		version   string
		wantValid bool
		wantErr   string
	}{
		{
			name:      "valid 24.0.9",
			version:   "24.0.9",
			wantValid: true,
		},
		{
			name:      "exactly minimum 24.0.0",
			version:   "24.0.0",
			wantValid: true,
		},
		{
			name:      "too old 23.0.0",
			version:   "23.0.0",
			wantValid: false,
			wantErr:   "too old",
		},
		{
			name:      "pre-release 25.0.0-rc1",
			version:   "25.0.0-rc1",
			wantValid: true,
		},
		{
			name:      "empty string",
			version:   "",
			wantValid: false,
			wantErr:   "not reachable",
		},
		{
			name:      "whitespace padded 24.0.9",
			version:   "  24.0.9  \n",
			wantValid: true,
		},
		{
			name:      "invalid version string",
			version:   "not-a-version",
			wantValid: false,
			wantErr:   "invalid",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			version := strings.TrimSpace(tt.version)
			if version == "" {
				if tt.wantValid {
					t.Error("expected valid but got empty string")
				}
				return
			}

			v := "v" + version
			valid := true
			errMsg := ""

			if !semver.IsValid(v) {
				valid = false
				errMsg = "invalid"
			} else if semver.Compare(v, "v24.0.0") < 0 {
				valid = false
				errMsg = "too old"
			}

			if tt.wantValid && !valid {
				t.Errorf("expected valid, got invalid (err: %s)", errMsg)
			}
			if !tt.wantValid && valid {
				t.Errorf("expected invalid (err: %q), got valid", tt.wantErr)
			}
			if !tt.wantValid && !valid && tt.wantErr != "" {
				if !strings.Contains(errMsg, tt.wantErr) {
					t.Errorf("error %q does not contain %q", errMsg, tt.wantErr)
				}
			}
		})
	}
}

// ──────────────────────────────────────────────
// dockerCheck adapter tests (seam-level)
// ──────────────────────────────────────────────

func TestDockerCheck_NotInstalled(t *testing.T) {
	saved := lookPath
	lookPath = func(_ string) (string, error) { return "", fmt.Errorf("executable not found in $PATH") }
	defer func() { lookPath = saved }()

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
	stubDockerLookPath(t)
	saved := runCommandContext
	runCommandContext = func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{runFn: func() error { return fmt.Errorf("Cannot connect to the Docker daemon") }}
	}
	defer func() { runCommandContext = saved }()

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
	stubDockerLookPath(t)
	saved := runCommandContext
	runCommandContext = func(_ context.Context, _ string, arg ...string) runner {
		if len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("connection refused") }}
		}
		return &mockCmd{}
	}
	defer func() { runCommandContext = saved }()

	res, err := dockerCheck(context.Background(), dockerCheckTimeout)
	if err != nil {
		t.Fatalf("dockerCheck returned error: %v", err)
	}
	if !strings.Contains(res.Err.Error(), "failed to get Docker Engine version") {
		t.Errorf("Err should mention version fetch failure: %v", res.Err)
	}
}

func TestDockerCheck_EmptyVersion(t *testing.T) {
	stubDockerLookPath(t)
	saved := runCommandContext
	runCommandContext = func(_ context.Context, _ string, arg ...string) runner {
		if len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("  \n"), nil }}
		}
		return &mockCmd{}
	}
	defer func() { runCommandContext = saved }()

	res, err := dockerCheck(context.Background(), dockerCheckTimeout)
	if err != nil {
		t.Fatalf("dockerCheck returned error: %v", err)
	}
	if res.Version != "" {
		t.Errorf("expected empty Version, got %q", res.Version)
	}
	if !strings.Contains(res.Err.Error(), "not reachable") {
		t.Errorf("Err should mention not reachable: %v", res.Err)
	}
}

func TestDockerCheck_TooOld(t *testing.T) {
	stubDockerLookPath(t)
	saved := runCommandContext
	runCommandContext = func(_ context.Context, _ string, arg ...string) runner {
		if len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("23.0.0"), nil }}
		}
		return &mockCmd{}
	}
	defer func() { runCommandContext = saved }()

	res, err := dockerCheck(context.Background(), dockerCheckTimeout)
	if err != nil {
		t.Fatalf("dockerCheck returned error: %v", err)
	}
	if !strings.Contains(res.Err.Error(), "too old, need >= 24.0.0") {
		t.Errorf("Err should mention minimum version: %v", res.Err)
	}
}

func TestDockerCheck_InvalidVersion(t *testing.T) {
	stubDockerLookPath(t)
	saved := runCommandContext
	runCommandContext = func(_ context.Context, _ string, arg ...string) runner {
		if len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("not-a-version"), nil }}
		}
		return &mockCmd{}
	}
	defer func() { runCommandContext = saved }()

	res, err := dockerCheck(context.Background(), dockerCheckTimeout)
	if err != nil {
		t.Fatalf("dockerCheck returned error: %v", err)
	}
	if !strings.Contains(res.Err.Error(), "invalid Docker Engine version") {
		t.Errorf("Err should mention invalid version: %v", res.Err)
	}
}

func TestDockerCheck_Healthy(t *testing.T) {
	stubDockerLookPath(t)
	saved := runCommandContext
	runCommandContext = func(_ context.Context, _ string, arg ...string) runner {
		if len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("25.0.0-rc1"), nil }}
		}
		return &mockCmd{}
	}
	defer func() { runCommandContext = saved }()

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
	stubDockerLookPath(t)
	var infoArgs, versionArgs []string
	saved := runCommandContext
	runCommandContext = func(_ context.Context, _ string, arg ...string) runner {
		if len(arg) > 0 && arg[0] == "info" {
			infoArgs = arg
			return &mockCmd{}
		}
		versionArgs = arg
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("24.0.9"), nil }}
	}
	defer func() { runCommandContext = saved }()

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
