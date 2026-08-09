package main

import (
	"context"
	"fmt"
	"os"
)

// runInitDockerCheck verifies Docker Engine is installed and running.
func runInitDockerCheck(ctx context.Context) error {
	result, err := dockerCheck(ctx, dockerCheckTimeout)
	if err != nil {
		return fmt.Errorf("docker check failed: %w", err)
	}
	if !result.Installed {
		return fmt.Errorf("Docker is not installed.\n\nPlease install Docker Engine 24.0+ from:\n  https://docs.docker.com/engine/install/")
	}
	if !result.Running {
		return fmt.Errorf("Docker Engine is installed but not running.\n\nPlease start Docker:\n  - Linux: sudo systemctl start docker\n  - macOS: open -a Docker\n  - Windows: Start 'Docker Desktop' from Start Menu")
	}
	if result.Err != nil {
		return fmt.Errorf("Docker version check: %w", result.Err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Docker Engine %s is installed and running\n", result.Version)
	return nil
}

// runInitScaffold writes .pi/settings.json from the embedded template.
// It resolves git identity from the system (git config, prompted only when
// missing) and hardcodes absolute /opt/cheasee-pi resource paths.
func runInitScaffold(
	ctx context.Context,
	workdir string,
	confirmFn func(string) (bool, error),
) error {
	fmt.Fprintf(os.Stderr, "  ℹ Creating .pi/settings.json...\n")

	gitName, gitEmail, _ := NewGitIdentity().Lookup()
	if gitName == "" || gitEmail == "" {
		ok, err := confirmFn("No git identity found. Configure git user.name and user.email for .pi/settings.json?")
		if err != nil {
			return err
		}
		if ok {
			promptedName, promptedEmail, err := promptGitIdentity()
			if err != nil {
				return fmt.Errorf("git identity prompt: %w", err)
			}
			if promptedName != "" {
				gitName = promptedName
			}
			if promptedEmail != "" {
				gitEmail = promptedEmail
			}
		} else {
			if gitName == "" {
				gitName = "Cheasee-Pi"
			}
			if gitEmail == "" {
				gitEmail = "cheasee-pi@localhost"
			}
		}
	}

	vals := TemplateSettingsValues{
		Provider:     initProvider,
		GitName:      gitName,
		GitEmail:     gitEmail,
		Memory:       "2G",
		CPUs:         "2.0",
		HasPrivatePi: hasPrivatePi(),
	}

	if err := NewSettingsScaffold().Scaffold(ctx, workdir, vals); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "  ✓ .pi/settings.json created\n")
	return nil
}
