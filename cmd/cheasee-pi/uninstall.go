package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

var (
	uninstallWorkdir  string
	uninstallForce    bool
	uninstallRemoveGit bool
)

var uninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Remove cheasee-pi configuration and extracted files",
	Long: `Remove cheasee-pi configuration files from the working directory.

The uninstall command removes:
  1. docker/ directory (compose files, Dockerfile, scripts)
  2. .pi/ directory (agent configuration, contexts, themes)
  3. Auth config (~/.config/cheasee-pi/auth.json)
  4. .git/ directory (if --remove-git is set)

Use --force to skip the confirmation prompt.`,
	DisableAutoGenTag: true,
	RunE:              runUninstallE,
}

func init() {
	rootCmd.AddCommand(uninstallCmd)
	uninstallCmd.Flags().StringVar(&uninstallWorkdir, "workdir", "", "Working directory (default: current directory)")
	uninstallCmd.Flags().BoolVar(&uninstallForce, "force", false, "Skip confirmation prompt")
	uninstallCmd.Flags().BoolVar(&uninstallRemoveGit, "remove-git", false, "Also remove .git directory")
}

func runUninstallE(cmd *cobra.Command, _ []string) error {
	workdir := uninstallWorkdir
	if workdir == "" {
		var err error
		workdir, err = os.Getwd()
		if err != nil {
			return fmt.Errorf("get working directory: %w", err)
		}
	}

	identify := func(path string) string {
		if _, err := os.Stat(path); err == nil {
			return "will remove"
		}
		return "not found"
	}

	dockerDir := filepath.Join(workdir, "docker")
	piDir := filepath.Join(workdir, ".pi")
	gitDir := filepath.Join(workdir, ".git")

	// Show summary
	fmt.Fprintf(os.Stderr, "The following will be removed:\n")
	fmt.Fprintf(os.Stderr, "  %s/docker/   — %s\n", filepath.Base(workdir), identify(dockerDir))
	fmt.Fprintf(os.Stderr, "  %s/.pi/      — %s\n", filepath.Base(workdir), identify(piDir))
	fmt.Fprintf(os.Stderr, "  %s/.git/     — %s", filepath.Base(workdir), identify(gitDir))
	if uninstallRemoveGit {
		fmt.Fprintf(os.Stderr, " (--remove-git)\n")
	} else {
		fmt.Fprintf(os.Stderr, " (use --remove-git to include)\n")
	}

	// Auth config
	repo := NewRepository()
	authPath, err := repo.Path()
	if err == nil {
		if _, err := os.Stat(authPath); err == nil {
			fmt.Fprintf(os.Stderr, "  %s        — will remove\n", authPath)
		}
	}

	if !uninstallForce {
		confirmed, err := promptConfirm("Permanently remove these files and directories?")
		if err != nil {
			return fmt.Errorf("confirmation prompt: %w", err)
		}
		if !confirmed {
			fmt.Fprintln(os.Stderr, "Uninstall cancelled.")
			return nil
		}
	}

	// Remove docker/
	if err := os.RemoveAll(dockerDir); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ failed to remove docker/: %v\n", err)
	} else {
		fmt.Fprintf(os.Stderr, "  ✓ Removed docker/\n")
	}

	// Remove .pi/
	if err := os.RemoveAll(piDir); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ failed to remove .pi/: %v\n", err)
	} else {
		fmt.Fprintf(os.Stderr, "  ✓ Removed .pi/\n")
	}

	// Remove .git/ (only if --remove-git)
	if uninstallRemoveGit {
		if err := os.RemoveAll(gitDir); err != nil {
			fmt.Fprintf(os.Stderr, "  ⚠ failed to remove .git/: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "  ✓ Removed .git/\n")
		}
	}

	// Remove auth config
	if err == nil {
		if err := os.Remove(authPath); err != nil && !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "  ⚠ failed to remove auth config: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "  ✓ Removed auth config\n")
		}
		// Try removing empty parent dir
		os.Remove(filepath.Dir(authPath)) // best-effort
	}

	fmt.Fprintf(os.Stderr, "\n✅ Uninstall complete.\n")
	return nil
}
