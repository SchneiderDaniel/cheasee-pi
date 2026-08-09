package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

// runInitScaffold writes cheasee-settings.json from the embedded template at
// the workspace root, then appends it to the worktree .gitignore (settings
// are machine-local, never committed). Resolves git identity from the system
// (git config, prompted only when missing). pi's own .pi/settings.json is
// intentionally NOT scaffolded — pi self-scaffolds it on first run.
func runInitScaffold(
	ctx context.Context,
	workdir string,
	confirmFn func(string) (bool, error),
) error {
	fmt.Fprintf(os.Stderr, "  ℹ Creating cheasee-settings.json...\n")

	gitName, gitEmail, _ := NewGitIdentity().Lookup()
	if gitName == "" || gitEmail == "" {
		ok, err := confirmFn("No git identity found. Configure git user.name and git user.email for cheasee-settings.json?")
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
		Provider: initProvider,
		GitName:  gitName,
		GitEmail: gitEmail,
		Memory:   "2G",
		CPUs:     "2.0",
		ClientID: initClientID,
	}

	if err := NewCheaseeSettingsScaffold().Scaffold(ctx, workdir, vals); err != nil {
		return err
	}
	if err := gitIgnoreCheaseeSettings(workdir); err != nil {
		return fmt.Errorf("gitignore cheasee-settings.json: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ cheasee-settings.json created\n")
	return nil
}

// gitIgnoreCheaseeSettings appends "cheasee-settings.json" to the worktree
// .gitignore so the machine-local settings never show up as untracked in git
// status. Idempotent: a second call (or an already-listed entry) adds no
// duplicate line. Creates .gitignore when missing.
func gitIgnoreCheaseeSettings(workdir string) error {
	path := filepath.Join(workdir, ".gitignore")
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if strings.Contains(string(data), "cheasee-settings.json") {
		return nil
	}
	line := "cheasee-settings.json\n"
	if len(data) > 0 && !strings.HasSuffix(string(data), "\n") {
		line = "\n" + line
	}
	return os.WriteFile(path, append(data, []byte(line)...), 0644)
}
