package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
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

// runInitExtract extracts embedded compose files to the working directory.
func runInitExtract(ctx context.Context, workdir string) error {
	fmt.Fprintf(os.Stderr, "  ℹ Extracting compose files...\n")
	if err := NewExtractor().Extract(ctx, workdir); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "  ✓ Compose files extracted to %s/docker\n", workdir)
	return nil
}

// runInitEnv generates docker/.env with host UID/GID and git identity.
func runInitEnv(ctx context.Context, workdir string, confirmFn func(string) (bool, error)) error {
	fmt.Fprintf(os.Stderr, "  ℹ Generating docker/.env...\n")

	uid, gid, err := NewUIDResolver().Current()
	if err != nil {
		return fmt.Errorf("resolve user UID/GID: %w", err)
	}

	gitName, gitEmail, err := NewGitIdentity().Lookup()
	if err != nil {
		// Git identity not found — not fatal, use defaults
		gitName = ""
		gitEmail = ""
	}

	if gitName == "" || gitEmail == "" {
		// Prompt for git identity
		ok, err := confirmFn("No git identity found. Configure git user.name and user.email?")
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

	vals := EnvValues{
		HostUID:  uid,
		HostGID:  gid,
		GitName:  gitName,
		GitEmail: gitEmail,
	}

	envPath := filepath.Join(workdir, "docker", ".env")
	if err := NewEnvRenderer().Render(ctx, envPath, vals); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "  ✓ docker/.env generated at %s\n", envPath)
	return nil
}

// runInitGitInit initializes a git repository in the working directory.
// This is only called on the --no-github path (clone creates .git otherwise).
func runInitGitInit(ctx context.Context, workdir string) error {
	fmt.Fprintf(os.Stderr, "  ℹ Initializing git repository...\n")
	if err := gitInit(ctx, workdir); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "  ✓ Git repository initialized\n")
	return nil
}

// runInitScaffold writes .pi/settings.json from the embedded template.
// It resolves git identity from the system (same fallback chain as runInitEnv).
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
		Provider: initProvider,
		GitName:  gitName,
		GitEmail: gitEmail,
		Memory:   "2G",
		CPUs:     "2.0",
	}

	if err := NewSettingsScaffold().Scaffold(ctx, workdir, vals); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "  ✓ .pi/settings.json created\n")
	return nil
}
