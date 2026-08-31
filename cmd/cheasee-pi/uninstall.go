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
  3. cheasee-pi binaries (the running executable plus every canonical
     install location: ~/.local/bin and /usr/local/bin)

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

	// Binary targets: the running executable plus every canonical install
	// location (deduped, existing files). Removing only the executable
	// stranded sibling copies — PATH order or sudo's secure_path can make
	// the running copy differ from the one the next shell call resolves,
	// leaving a stale binary shadowing the fresh install.
	binaries := canonicalBinaryPaths()

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

	// Binaries
	for _, p := range binaries {
		fmt.Fprintf(os.Stderr, "  %s — will remove\n", p)
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

	// Remove binaries (last — running process keeps the file handle)
	for _, p := range binaries {
		binaryDir := filepath.Dir(p)
		// Check if parent dir is writable — if not, suggest sudo
		if f, err := os.Stat(binaryDir); err == nil && f.Mode().Perm()&0o222 == 0 {
			fmt.Fprintf(os.Stderr, "  ⚠ cannot remove binary — %s is not writable by you\n", binaryDir)
			fmt.Fprintf(os.Stderr, "    Remove it manually: sudo rm %s\n", p)
		} else if err := os.Remove(p); err != nil {
			fmt.Fprintf(os.Stderr, "  ⚠ failed to remove binary at %s\n", p)
			fmt.Fprintf(os.Stderr, "    Cause: %v\n", err)
			fmt.Fprintf(os.Stderr, "    Remove it manually: sudo rm %s\n", p)
		} else {
			fmt.Fprintf(os.Stderr, "  ✓ Removed binary %s\n", p)
		}
	}

	fmt.Fprintf(os.Stderr, "\n✅ Uninstall complete.\n")
	return nil
}

// canonicalBinaryPaths returns the binary targets uninstall must remove: the
// running executable (symlink-resolved; Go build-cache/tmp runs skipped)
// plus the canonical install locations ~/.local/bin and /usr/local/bin.
// Deduped; only existing files are listed so the summary stays quiet about
// absent paths.
func canonicalBinaryPaths() []string {
	add := func(seen map[string]bool, out []string, p string) []string {
		if p == "" || seen[p] {
			return out
		}
		if _, err := os.Stat(p); err != nil {
			return out
		}
		seen[p] = true
		return append(out, p)
	}
	seen := map[string]bool{}
	out := []string{}
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		if !strings.Contains(exe, "/go-build") && !strings.Contains(exe, "/tmp/go") {
			out = add(seen, out, exe)
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		out = add(seen, out, filepath.Join(home, ".local", "bin", "cheasee-pi"))
	}
	return add(seen, out, "/usr/local/bin/cheasee-pi")
}
