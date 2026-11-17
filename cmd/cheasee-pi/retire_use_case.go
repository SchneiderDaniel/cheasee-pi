package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The use case: reconcile one workspace to "no deprecated registration, no
// deprecated checkout", in one ordered pass.

// retirePackages is the use case: reconcile one workspace to "no deprecated
// registration, no deprecated checkout". It owns the ordering (a broken file
// aborts before anything is written, settings are written before the checkout is
// deleted), the live-session refusal and error propagation. It never returns a
// partial success: any failure the caller could act on comes back as an error.
//
// Re-running is a no-op, and the clone step also reclaims a checkout a previous
// failed run left behind, so the use case is state-based and converges.
func retirePackages(root string, opts retireOptions) (retireReport, error) {
	var rep retireReport

	// Read both files first: a malformed file on either side must abort before
	// anything is written, so a failed migration never leaves half a state.
	cheasee, cheaseePresent, err := loadCheaseeSettingsIfPresent(root)
	if err != nil {
		return rep, fmt.Errorf("read cheasee-settings.json: %w", err)
	}
	piSettings, piPresent, err := loadPISettingsIfPresent(root)
	if err != nil {
		return rep, fmt.Errorf("read .pi/settings.json: %w", err)
	}
	packages, err := piPackages(piSettings)
	if err != nil {
		return rep, err
	}
	var skillRepos []string
	if cheasee != nil {
		skillRepos = cheasee.SkillRepos
	}

	// A live session owns this workspace: rewriting the settings under a
	// running pi is exactly the race the in-use claim exists to expose.
	claims, err := liveSessionClaims(root)
	if err != nil {
		return rep, err
	}
	if len(claims) > 0 {
		return rep, fmt.Errorf("workspace is in use by a running session (%s) — close it, then re-run",
			strings.Join(claims, ", "))
	}

	plan, err := planRetirement(packages, skillRepos)
	if err != nil {
		return rep, err
	}
	if opts.Confirm {
		// Explicit consent turns the unprovable entries into removal targets;
		// the clone decision is recomputed against the wider set.
		plan.Auto = append(plan.Auto, plan.NeedsConfirm...)
		plan.NeedsConfirm = nil
		plan.CloneRemovable = planCloneRemoval(mustDecodeRetireElements(packages), skillRepos, plan.Auto)
	}

	for _, entry := range plan.NeedsConfirm {
		rep.NeedsConfirmation = appendStringUnique(rep.NeedsConfirmation, entry.Source)
		// The audit trail: the operator has to learn this survived, and with
		// which command to finish the job.
		fmt.Fprintf(os.Stderr, "  ⚠ %s is still registered and cannot be proven a harness leftover — run `%s` to remove it, or delete it yourself if you installed it.\n",
			entry.Source, confirmHint)
	}
	for _, entry := range plan.Auto {
		rep.Removed = appendStringUnique(rep.Removed, entry.Source)
	}

	// The checkout decision is a precondition, not part of the deletion: a
	// symlink at that path is not the directory pi created, and following it
	// would delete whatever it points at.
	clonePath := filepath.Join(root, retiredCloneRel)
	clonePresent, cloneIsSymlink, err := inspectRetireClone(clonePath)
	if err != nil {
		return rep, err
	}
	removeClone := clonePresent && plan.CloneRemovable
	if removeClone && cloneIsSymlink {
		return rep, fmt.Errorf("refusing to remove %s: it is a symlink, not the checkout pi created — inspect its target and delete it yourself", retiredCloneRel)
	}
	if opts.DryRun {
		if removeClone {
			rep.CloneRemoved = append(rep.CloneRemoved, retiredCloneRel)
		}
		return rep, nil
	}

	if err := writeRetiredSettings(root, cheasee, cheaseePresent, piSettings, piPresent,
		plan.Auto, skillRepos, packages); err != nil {
		return rep, err
	}

	if removeClone {
		if err := os.RemoveAll(clonePath); err != nil {
			return rep, fmt.Errorf("remove %s: %w", retiredCloneRel, err)
		}
		rep.CloneRemoved = append(rep.CloneRemoved, retiredCloneRel)
	}
	return rep, nil
}
