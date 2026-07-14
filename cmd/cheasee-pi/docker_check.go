package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"golang.org/x/mod/semver"
)

// Checker checks Docker Engine availability and version.
type Checker interface {
	Check(ctx context.Context) (*CheckResult, error)
}

// CheckResult contains Docker Engine status information.
type CheckResult struct {
	Installed bool
	Running   bool
	Version   string
	Err       error
}

// execChecker implements Checker by shelling out to the docker CLI.
type execChecker struct {
	timeout time.Duration
}

// NewChecker creates a Checker with the given per-command timeout.
func NewChecker(timeout time.Duration) Checker {
	return &execChecker{timeout: timeout}
}

func (c *execChecker) Check(ctx context.Context) (*CheckResult, error) {
	res := &CheckResult{}

	// 1. Check if docker binary exists.
	if _, err := exec.LookPath("docker"); err != nil {
		res.Installed = false
		res.Running = false
		res.Err = fmt.Errorf("docker not found: %w", err)
		return res, nil
	}
	res.Installed = true

	// 2. Check if Docker daemon is responsive.
	infoCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	infoCmd := exec.CommandContext(infoCtx, "docker", "info")
	if err := infoCmd.Run(); err != nil {
		res.Running = false
		res.Err = fmt.Errorf("Docker daemon not running: %w", err)
		return res, nil
	}
	res.Running = true

	// 3. Get Docker Engine version.
	verCtx, cancel2 := context.WithTimeout(ctx, c.timeout)
	defer cancel2()

	verCmd := exec.CommandContext(verCtx, "docker", "version", "--format", "{{.Server.Version}}")
	output, err := verCmd.Output()
	if err != nil {
		res.Err = fmt.Errorf("failed to get Docker Engine version: %w", err)
		return res, nil
	}

	version := strings.TrimSpace(string(output))
	res.Version = version

	if version == "" {
		res.Err = fmt.Errorf("Docker Engine not reachable or not installed")
		return res, nil
	}

	// 4. Verify version >= 24.0.0 using semver.
	// semver.Compare requires "v" prefix.
	v := "v" + version
	if !semver.IsValid(v) {
		res.Err = fmt.Errorf("invalid Docker Engine version: %s", version)
		return res, nil
	}

	if semver.Compare(v, "v24.0.0") < 0 {
		res.Err = fmt.Errorf("Docker Engine %s is too old, need >= 24.0.0", version)
		return res, nil
	}

	return res, nil
}
