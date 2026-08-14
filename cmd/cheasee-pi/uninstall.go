package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

var uninstallForce bool

var uninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Remove cheasee-pi configuration and extracted files",
	Long: `Remove cheasee-pi configuration files and CLI-managed assets.

The uninstall command removes:
  1. Cache dir (compose/Dockerfile under the user cache dir)
  2. Auth config (~/.config/cheasee-pi/auth.json)
  3. cheasee-pi binary (the running executable)

Workspace files (.pi/, .git/, source checkouts) are never touched.
Use --force to skip the confirmation prompt.`,
	DisableAutoGenTag: true,
	RunE:              runUninstallE,
}

func init() {
	rootCmd.AddCommand(uninstallCmd)
	uninstallCmd.Flags().BoolVar(&uninstallForce, "force", false, "Skip confirmation prompt")
}

func runUninstallE(cmd *cobra.Command, _ []string) error {
	identify := func(path string) string {
		if _, err := os.Stat(path); err == nil {
			return "will remove"
		}
		return "not found"
	}

	// CLI-managed assets live in the version-keyed cache dir, never the repo.
	cacheDir, _ := CacheDir()

	// Detect binary path — skip if running from Go build cache
	binaryPath, _ := os.Executable()
	if binaryPath != "" {
		// Resolve symlinks to get real path
		if resolved, err := filepath.EvalSymlinks(binaryPath); err == nil {
			binaryPath = resolved
		}
		// Skip removal if binary is in a Go build cache or temp directory
		if strings.Contains(binaryPath, "/go-build") || strings.Contains(binaryPath, "/tmp/go") {
			binaryPath = ""
		}
	}

	// Show summary
	fmt.Fprintf(os.Stderr, "The following will be removed:\n")
	if cacheDir != "" {
		fmt.Fprintf(os.Stderr, "  %s        — %s\n", cacheDir, identify(cacheDir))
	}

	// Auth config
	repo := &fileRepository{}
	authPath, err := repo.Path()
	if err == nil {
		if _, err := os.Stat(authPath); err == nil {
			fmt.Fprintf(os.Stderr, "  %s        — will remove\n", authPath)
		}
	}

	// Binary
	if binaryPath != "" {
		fmt.Fprintf(os.Stderr, "  %s — will remove\n", binaryPath)
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

	// Remove cache dir (CLI-managed compose/Dockerfile)
	if cacheDir != "" {
		if err := os.RemoveAll(cacheDir); err != nil {
			fmt.Fprintf(os.Stderr, "  ⚠ failed to remove cache dir: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "  ✓ Removed cache dir\n")
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

	// Remove binary (last — running process keeps the file handle)
	if binaryPath != "" {
		binaryDir := filepath.Dir(binaryPath)
		// Check if parent dir is writable — if not, suggest sudo
		if f, err := os.Stat(binaryDir); err == nil && f.Mode().Perm()&0o222 == 0 {
			fmt.Fprintf(os.Stderr, "  ⚠ cannot remove binary — %s is not writable by you\n", binaryDir)
			fmt.Fprintf(os.Stderr, "    Remove it manually: sudo rm %s\n", binaryPath)
		} else if err := os.Remove(binaryPath); err != nil {
			fmt.Fprintf(os.Stderr, "  ⚠ failed to remove binary at %s\n", binaryPath)
			fmt.Fprintf(os.Stderr, "    Cause: %v\n", err)
			fmt.Fprintf(os.Stderr, "    Remove it manually: sudo rm %s\n", binaryPath)
		} else {
			fmt.Fprintf(os.Stderr, "  ✓ Removed binary\n")
		}
	}

	fmt.Fprintf(os.Stderr, "\n✅ Uninstall complete.\n")
	return nil
}
