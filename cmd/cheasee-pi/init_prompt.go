package main

import (
	"charm.land/huh/v2"
)

// promptConfirm shows a yes/no confirmation dialog.
func promptConfirm(title string) (bool, error) {
	var confirmed bool
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title(title).
				Value(&confirmed),
		),
	)
	err := form.Run()
	return confirmed, err
}

// promptGitIdentity prompts for git user.name and user.email.
func promptGitIdentity() (name, email string, err error) {
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().Title("Git user.name").Value(&name),
			huh.NewInput().Title("Git user.email").Value(&email),
		),
	)
	err = form.Run()
	return name, email, err
}

// promptInput shows an interactive text input using huh and returns the entered value.
func promptInput(title, placeholder string) (string, error) {
	var value string
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title(title).
				Placeholder(placeholder).
				Value(&value),
		),
	)
	err := form.Run()
	return value, err
}

// runInitPromptSource resolves the source repository to fork from.
// Returns "SchneiderDaniel/cheasee-pi" by default, or --source-repo if set.
func runInitPromptSource(sfi SourceForkInput) (string, error) {
	switch sfi.Mode {
	case ModeUseForkURL:
		// For fork URL mode, derive source repo from the fork URL
		owner, repo := ParseGitHubURL(sfi.ForkURL)
		if owner != "" && repo != "" {
			return owner + "/" + repo, nil
		}
		return "SchneiderDaniel/cheasee-pi", nil
	case ModeSkipFork:
		// Skip fork entirely — source repo is not used
		if sfi.SourceRepo != "" {
			return sfi.SourceRepo, nil
		}
		return "SchneiderDaniel/cheasee-pi", nil
	}

	if sfi.SourceRepo != "" {
		// User explicitly provided --source-repo
		return sfi.SourceRepo, nil
	}

	return "SchneiderDaniel/cheasee-pi", nil
}
