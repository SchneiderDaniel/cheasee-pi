package main

import (
	"github.com/spf13/cobra"
)

// Lifecycle groups for the root help output. Cobra renders groups in the
// order AddGroup() is called; within a group, commands sort alphabetically.
const (
	groupIDGettingStarted = "getting-started"
	groupIDDailyUse       = "daily-use"
	groupIDMaintenance    = "maintenance"
	groupIDHelp           = "help"
)

// docsDailyUsageURL is the rendered docs site's daily-usage page — the full
// mental model the root help points a first-time user at.
const docsDailyUsageURL = "https://schneiderdaniel.github.io/cheasee-pi/daily-usage"

var rootCmd = &cobra.Command{
	Use:   "cheasee-pi",
	Short: "Cheasee-PI — Token-saving Pi agent harness with Docker setup",
	Long: `Cheasee-PI runs the pi coding agent (https://pi.dev) inside a Docker
container — one container per GitHub repo — and handles API keys and the
container lifecycle for you.

Without a subcommand, 'cheasee-pi' checks the current folder: empty →
runs 'cheasee-pi init' (which stops — run 'cheasee-pi start' again to
launch pi); cheasee-settings.json present → launches pi inside the Docker
container; non-empty without it → error (run init in an empty folder).

First run: 'cheasee-pi init' in an empty folder, then 'cheasee-pi start'.
Day-to-day: 'cheasee-pi down' stops the container, 'cheasee-pi auth'
manages provider API keys. Full walkthrough: ` + docsDailyUsageURL,
	Version:           cliVersionKey,
	DisableAutoGenTag: true,
	// SilenceUsage: a runtime (RunE) error must not dump the full usage block
	// after the message — the error text itself carries the next step. Cobra
	// also suppresses the usage dump on flag/arg parse errors; the plain error
	// line remains the only guidance on both paths.
	SilenceUsage: true,
	RunE:         runUpE,
}

func init() {
	// AddGroup order = render order in the grouped help template.
	rootCmd.AddGroup(
		&cobra.Group{ID: groupIDGettingStarted, Title: "Getting started"},
		&cobra.Group{ID: groupIDDailyUse, Title: "Daily use"},
		&cobra.Group{ID: groupIDMaintenance, Title: "Maintenance"},
		&cobra.Group{ID: groupIDHelp, Title: "Help"},
	)
	// Cobra's auto-registered help/completion commands take their group from
	// these setters — otherwise they'd fall into "Additional Commands:".
	rootCmd.SetHelpCommandGroupID(groupIDHelp)
	rootCmd.SetCompletionCommandGroupID(groupIDHelp)
}
