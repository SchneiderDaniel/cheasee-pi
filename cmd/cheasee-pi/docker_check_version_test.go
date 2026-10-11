package main

import (
	"context"
	"strings"
	"testing"

	"golang.org/x/mod/semver"
)

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

func TestDockerCheck_EmptyVersion(t *testing.T) {
	stubDockerCheck(t, nil, "  \n", nil)

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
	stubDockerCheck(t, nil, "23.0.0", nil)

	res, err := dockerCheck(context.Background(), dockerCheckTimeout)
	if err != nil {
		t.Fatalf("dockerCheck returned error: %v", err)
	}
	if !strings.Contains(res.Err.Error(), "too old, need >= 24.0.0") {
		t.Errorf("Err should mention minimum version: %v", res.Err)
	}
}

func TestDockerCheck_InvalidVersion(t *testing.T) {
	stubDockerCheck(t, nil, "not-a-version", nil)

	res, err := dockerCheck(context.Background(), dockerCheckTimeout)
	if err != nil {
		t.Fatalf("dockerCheck returned error: %v", err)
	}
	if !strings.Contains(res.Err.Error(), "invalid Docker Engine version") {
		t.Errorf("Err should mention invalid version: %v", res.Err)
	}
}
