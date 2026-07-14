package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"charm.land/huh/v2"
	"github.com/spf13/cobra"
)

var (
	initAPIKey        string
	initNoDockerCheck bool
)

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize cheasee-pi configuration",
	Long: `Initialize cheasee-pi by verifying Docker is installed and running,
and setting up your API key configuration.

The init command will:
  1. Verify Docker Engine 24.0+ is installed and running
  2. Prompt for an API key (or use --api-key flag)
  3. Save configuration to ~/.config/cheasee-pi/auth.json`,
	DisableAutoGenTag: true,
	RunE:              runInitE,
}

func init() {
	rootCmd.AddCommand(initCmd)
	initCmd.Flags().StringVar(&initAPIKey, "api-key", "", "API key (skips interactive prompt)")
	initCmd.Flags().BoolVar(&initNoDockerCheck, "no-docker-check", false, "Skip Docker Engine check")
}

func runInitE(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
	}

	dockerChecker := NewChecker(5 * time.Second)
	configRepo := NewRepository()

	return runInit(ctx, dockerChecker, configRepo, initAPIKey, initNoDockerCheck)
}

func runInit(
	ctx context.Context,
	docker Checker,
	cfg Repository,
	apiKey string,
	noDockerCheck bool,
) error {
	if !noDockerCheck {
		result, err := docker.Check(ctx)
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
		fmt.Fprintf(os.Stderr, "✓ Docker Engine %s is installed and running\n", result.Version)
	}

	if apiKey == "" {
		key, err := promptAPIKey()
		if err != nil {
			return fmt.Errorf("API key prompt failed: %w", err)
		}
		apiKey = key
	}

	auth := &Auth{APIKey: apiKey}
	if err := cfg.Save(ctx, auth); err != nil {
		return fmt.Errorf("failed to save auth config: %w", err)
	}

	path, _ := cfg.Path()
	fmt.Fprintf(os.Stderr, "✓ Auth config saved to %s\n", path)

	return nil
}

func promptAPIKey() (string, error) {
	var apiKey string

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("API Key").
				Prompt("Enter your API key: ").
				Value(&apiKey),
		),
	)

	err := form.Run()
	return apiKey, err
}
