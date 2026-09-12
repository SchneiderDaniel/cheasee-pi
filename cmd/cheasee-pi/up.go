package main

import (
	"github.com/spf13/cobra"
)

var (
	upName          string
	upWorkdir       string
	upBuild         bool
	upNoDockerCheck bool
	upAPIKey        string
	upDryRun        bool
)

var upCmd = &cobra.Command{
	Use:     "start",
	Aliases: []string{"up"},
	Short:   "Launch pi inside container with provider keys injected",
	Long: `Launch an interactive pi session inside the Cheasee-Pi Docker container.

Runs from a cheasee-pi workspace: the workspace folder (main worktree) is
bind-mounted at /workspaces/main and its sibling bare repo at
/workspaces/.bare inside the container. compose/Dockerfile live in a
CLI-managed cache dir; the dedicated cheasee-settings.json (gitignored,
machine-local) is the initialized marker.

Empty folder → runs cheasee-pi init and stops (init never launches pi);
run 'cheasee-pi start' again to launch. Non-empty folder without
cheasee-settings.json is refused — run 'cheasee-pi init' in an empty folder.

The image clones the cheasee-pi repo at build time (Dockerfile ARG
CHEASEE_REF) for its .pi resources. Reads provider API keys from
~/.config/cheasee-pi/auth.json and passes them as environment variables to
 the container, so pi finds models without manual /login.

If the container is not running, starts it with docker compose up first.
Use --build to force rebuild.

Examples:
  cheasee-pi start               # start pi with keys from auth.json
  cheasee-pi start --build       # rebuild, then start pi
  cheasee-pi start --api-key ..  # temporary key for this session`,
	DisableAutoGenTag: true,
	RunE:              runUpE,
}

func init() {
	rootCmd.AddCommand(upCmd)
	upCmd.Flags().StringVar(&upName, "name", "cheasee-pi", "Container name (default: derived from the repo, cheasee-pi-<slug>)")
	upCmd.Flags().StringVar(&upWorkdir, "workdir", "", "Working directory (default: current directory)")
	upCmd.Flags().BoolVar(&upBuild, "build", false, "Rebuild container image before starting")
	upCmd.Flags().BoolVar(&upNoDockerCheck, "no-docker-check", false, "Skip Docker Engine check")
	upCmd.Flags().StringVar(&upAPIKey, "api-key", "", "Provider API key for this session (not saved)")
	upCmd.Flags().BoolVar(&upDryRun, "dry-run", false, "Print env vars that would be passed, then exit")
}
