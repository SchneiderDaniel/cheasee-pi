package main

import (
	"fmt"
	"os"

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
  CHEASEE_REF Dockerfile build ARG (default main); which cheasee-pi ref the image
              clones. The baked commit is recorded at /opt/cheasee-pi/BUILD_COMMIT
`

// aboutFooter reuses root.go's docsDailyUsageURL (single source for the
// published URL — the CLI-relative path stays next to it, mirroring the
// codeflow_hint.go relative-path convention).
const aboutFooter = "Full workflow: docs/daily-usage.md — " + docsDailyUsageURL

// aboutBakedCommit reports the commit baked into the current workspace's image
// at /opt/cheasee-pi (issue #2054). It reads the CLI's record of that image's
// last successful build — the resolved commit, or (when the upstream probe
// failed) the commit the built image itself recorded — so it equals the baked
// copy. Scoped to the workspace's own image: the compose dir is shared by
// every workspace, so a shared record reported another workspace's commit
// while this image still held a stale one (issue #2054 audit). Empty when the
// cwd is not a workspace or no build has been recorded yet (the glossary then
// omits the line).
func aboutBakedCommit() string {
	imageRef := aboutImageRef()
	if imageRef == "" {
		return ""
	}
	dir, err := aboutCacheDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "  \u26a0 baked cheasee-pi commit: %v\n", err)
		return ""
	}
	return readBakedCommit(dir, imageRef).commit
}

// aboutImageRef is the image `about` describes: the current workspace's image,
// resolved from the working directory (the same resolution start/down use).
// Empty outside a cheasee-pi workspace — there is then no image to report.
// Injectable so tests never depend on the cwd.
var aboutImageRef = func() string {
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	root, state, err := resolveStartWorkspace(wd)
	if err != nil || state != WorkspaceInitialized {
		return ""
	}
	return cheaseeImageRef(root)
}

// aboutCacheDir resolves the dir holding the baked-commit records; injectable
// so tests never touch the real user cache.
var aboutCacheDir = CacheDir

func runAboutE(cmd *cobra.Command, _ []string) error {
	// A broken stdout writer must fail the command, not silently succeed
	// with partial output: check each write, stop on the first failure.
	out := cmd.OutOrStdout()
	if _, err := fmt.Fprint(out, aboutText); err != nil {
		return fmt.Errorf("writing about glossary: %w", err)
	}
	if commit := aboutBakedCommit(); commit != "" {
		if _, err := fmt.Fprintf(out, "\n  baked cheasee-pi commit  %s   (/opt/cheasee-pi/BUILD_COMMIT)\n", commit); err != nil {
			return fmt.Errorf("writing about baked commit: %w", err)
		}
	}
	if _, err := fmt.Fprintln(out, aboutFooter); err != nil {
		return fmt.Errorf("writing about footer: %w", err)
	}
	return nil
}
