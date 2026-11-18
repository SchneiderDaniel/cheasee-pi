package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

// Cobra flag binding store for `cheasee-pi migrate`. The flags write here and
// runMigrateE copies them into a retireOptions value, so a second run in the
// same process cannot inherit a stale --confirm.
var (
	migrateWorkdir string
	migrateConfirm bool
	migrateDryRun  bool
)

// migrateCmd reconciles an existing workspace with a release that no longer
// ships a package the workspace still registers. It is the explicit, scriptable
// entry point of the same migration 'cheasee-pi start' runs automatically.
var migrateCmd = &cobra.Command{
	Use:     "migrate",
	GroupID: groupIDMaintenance,
	Short:   "Reconcile a workspace with packages this release no longer ships",
	Long: `Reconcile an existing workspace with a release that dropped a bundled
package.

An upgrade does not replace your workspace: the container bind-mounts it, so
the .pi/settings.json pi loads — and the skillRepos list the container
entrypoint installs from on every start — survive an image rebuild. A package
entry recorded by an older release therefore keeps loading.

migrate removes exactly the deprecated registration and exactly the checkout
behind it: the .pi/settings.json packages element, the cheasee-settings.json
skillRepos seed, and the project-local clone under .pi/git/. Every other
package, skill repository and clone is preserved, and re-running is a no-op.

'cheasee-pi start' runs the same migration before the container starts, so
this command is only needed to inspect the change (--dry-run), to run it
without starting pi, or to finish an entry the migration cannot classify.

One shape needs explicit consent: a bare-string package entry with no
harness-written skillRepos seed beside it may be your own install, so it is
left alone — and named on stderr — until --confirm is passed.

migrate is refused while a session holds the workspace: close it first.

Examples:
  cheasee-pi migrate --dry-run           # show what would be removed, touch nothing
  cheasee-pi migrate                     # remove what is provably a harness leftover
  cheasee-pi migrate --confirm           # also remove what it cannot classify
  cheasee-pi migrate --workdir ..        # migrate a specific workspace`,
	DisableAutoGenTag: true,
	RunE:              runMigrateE,
}

func init() {
	rootCmd.AddCommand(migrateCmd)
	migrateCmd.Flags().StringVar(&migrateWorkdir, "workdir", "", "Working directory (default: current directory)")
	migrateCmd.Flags().BoolVar(&migrateConfirm, "confirm", false, "Also remove deprecated entries the migration cannot prove the harness wrote")
	migrateCmd.Flags().BoolVar(&migrateDryRun, "dry-run", false, "Print what would be removed without touching any file")
}

// runMigrateE is the cobra adapter: resolve the workspace the same way start
// does, hand the use case a plain value, print its report. No business
// decision lives here.
func runMigrateE(_ *cobra.Command, _ []string) error {
	workdir, err := resolveWorkdir(migrateWorkdir)
	if err != nil {
		return fmt.Errorf("resolve workdir: %w", err)
	}
	// Same gate as start: never edit a folder cheasee-pi does not own.
	root, state, err := resolveStartWorkspace(workdir)
	if err != nil {
		return err
	}
	if state != WorkspaceInitialized {
		return fmt.Errorf("not initialized: %q is not empty and has no cheasee-settings.json — run `cheasee-pi init` in an empty folder first", workdir)
	}

	rep, err := retirePackages(root, retireOptions{Confirm: migrateConfirm, DryRun: migrateDryRun})
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	printRetireReport(rep, migrateDryRun)
	return nil
}
