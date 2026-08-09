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
