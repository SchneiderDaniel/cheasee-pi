package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

// aboutCmd prints a ~10-line glossary of cheasee-pi's core concepts plus doc
// links. Non-interactive, pure print: every other help text can stay short
// and defer the domain jargon here (clig.dev: help says just enough).
var aboutCmd = &cobra.Command{
	Use:     "about",
	Aliases: []string{"intro"},
	GroupID: groupIDGettingStarted,
	Short:   "Print a ~10-line glossary of core concepts + workflow links",
	Long: `Print a short glossary of cheasee-pi's core concepts (workspace, bare
repo, worktree, container, provider, skill repo, CodeFlow, CHEASEE_REF)
plus the one-sentence workflow. Non-interactive; the long-form mental
model lives in docs/daily-usage.md, linked below.`,
	DisableAutoGenTag: true,
	RunE:              runAboutE,
}

func init() {
	rootCmd.AddCommand(aboutCmd)
}

// aboutText is the single-source glossary body printed by 'cheasee-pi about'.
// Each term stays a one-liner; long-form definitions are canonical in
// docs/daily-usage.md + docs/cli.md and linked by aboutFooter.
const aboutText = `Cheasee-Pi runs the Pi coding agent (pi.dev) inside Docker, one workspace per repo.

workflow    cheasee-pi init → auth add <provider> → cheasee-pi start; docs below

  workspace   one folder = one worktree of one GitHub repo; cheasee-settings.json marks it
  bare repo   git clone without a checkout — your repo's sibling .bare clone
  worktree    checked-out working copy of the bare repo (the folder you edit)
  container   Docker image with pi + your repo mounted; Docker is required to
              isolate each workspace's pi runtime and mount the repo inside
  provider    LLM vendor; key in ~/.config/cheasee-pi/auth.json, injected as env vars
  skill repo  reusable pi instructions; installed via pi install -l (writes .pi/settings.json)
  CodeFlow    optional browser sidecar; port 8470 + fnv32(repo-slug) % 1024
  CHEASEE_REF Dockerfile build ARG (default main); which cheasee-pi ref the image clones
`

// aboutFooter reuses root.go's docsDailyUsageURL (single source for the
// published URL — the CLI-relative path stays next to it, mirroring the
// codeflow_hint.go relative-path convention).
const aboutFooter = "Full workflow: docs/daily-usage.md — " + docsDailyUsageURL

func runAboutE(cmd *cobra.Command, _ []string) error {
	// A broken stdout writer must fail the command, not silently succeed
	// with partial output: check each write, stop on the first failure.
	out := cmd.OutOrStdout()
	if _, err := fmt.Fprint(out, aboutText); err != nil {
		return fmt.Errorf("writing about glossary: %w", err)
	}
	if _, err := fmt.Fprintln(out, aboutFooter); err != nil {
		return fmt.Errorf("writing about footer: %w", err)
	}
	return nil
}
