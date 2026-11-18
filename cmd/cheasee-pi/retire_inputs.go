package main

import (
	"encoding/json"
	"fmt"
)

// The workspace as read: both settings files, pi's undecoded `packages` array and
// the skillRepos specs the classifier works on.

// retireInputs is one workspace's settings state. Presence is tracked per file: a
// missing `.pi/settings.json` is not a reason to create one, and a missing
// cheasee-settings.json not a reason to fail.
type retireInputs struct {
	cheasee        *CheaseeSettings
	cheaseePresent bool
	pi             *Settings
	piPresent      bool
	packages       []json.RawMessage
	skillRepos     []string
}

// readRetireInputs reads both files before anything is written: a malformed file
// on either side aborts the run, so a failed migration never leaves half a state.
func readRetireInputs(root string) (retireInputs, error) {
	var in retireInputs
	cheasee, cheaseePresent, err := loadCheaseeSettingsIfPresent(root)
	if err != nil {
		return in, fmt.Errorf("read cheasee-settings.json: %w", err)
	}
	in.cheasee, in.cheaseePresent = cheasee, cheaseePresent
	if cheasee != nil {
		in.skillRepos = cheasee.SkillRepos
	}
	pi, piPresent, err := loadPISettingsIfPresent(root)
	if err != nil {
		return in, fmt.Errorf("read .pi/settings.json: %w", err)
	}
	in.pi, in.piPresent = pi, piPresent
	packages, err := piPackages(pi)
	if err != nil {
		return in, err
	}
	in.packages = packages
	return in, nil
}

// buildRetirePlan classifies the registrations. Explicit consent turns the
// unprovable entries into removal targets; the checkout decision is recomputed
// against that wider set, because an entry the run now removes no longer keeps the
// clone alive.
func buildRetirePlan(packages []json.RawMessage, skillRepos []string, confirm bool) (retirePlan, error) {
	plan, err := planRetirement(packages, skillRepos)
	if err != nil {
		return plan, err
	}
	if !confirm {
		return plan, nil
	}
	plan.Auto = append(plan.Auto, plan.NeedsConfirm...)
	plan.NeedsConfirm = nil
	plan.CloneRemovable = planCloneRemoval(mustDecodeRetireElements(packages), skillRepos, plan.Auto)
	return plan, nil
}
