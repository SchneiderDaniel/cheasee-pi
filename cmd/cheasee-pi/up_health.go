package main

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// waitHealthy polls the container health until healthy or the timeout
// expires (2s interval). The entrypoint touches /tmp/.cheasee-pi-ready only
// after all setup completes, so healthy implies pi can exec safely.
func waitHealthy(ctx context.Context, name string) error {
	deadline := time.Now().Add(healthWaitTimeout)
	for {
		status, err := containerHealth(ctx, name)
		if err != nil {
			return err
		}
		if status == "healthy" {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("container %s not healthy after %s (status %q) — check `docker logs %s` for entrypoint errors", name, healthWaitTimeout, status, name)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// containerHealth returns the container's health status via docker inspect.
func containerHealth(ctx context.Context, name string) (string, error) {
	out, err := runCommandContext(ctx, "docker", "inspect", "--format", "{{.State.Health.Status}}", name).Output()
	if err != nil {
		return "", fmt.Errorf("docker inspect: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

// healthWaitTimeout bounds the ready-wait before execing pi. First-run npm
// install dominates (workspace deps); generous by default.
var healthWaitTimeout = 5 * time.Minute
