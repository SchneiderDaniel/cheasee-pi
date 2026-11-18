package main

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

	inputs, err := readRetireInputs(root)
	if err != nil {
		return rep, err
	}
	if err := refuseInUseWorkspace(root); err != nil {
		return rep, err
	}
	plan, err := buildRetirePlan(inputs.packages, inputs.skillRepos, opts.Confirm)
	if err != nil {
		return rep, err
	}
	rep = announceRetirePlan(plan)

	// The checkout decision is a precondition, not part of the deletion: a link
	// anywhere between the workspace and the checkout is not the directory pi
	// created, and following it would delete whatever it points at.
	clone, err := inspectRetiredClone(root)
	if err != nil {
		return rep, err
	}
	if err := checkCloneDeletable(clone, plan.CloneRemovable); err != nil {
		return rep, err
	}
	removeClone := clone.Present && plan.CloneRemovable
	if opts.DryRun {
		return dryRunReport(rep, removeClone), nil
	}

	if err := writeRetiredSettings(root, inputs, plan.Auto); err != nil {
		return rep, err
	}
	if !removeClone {
		return rep, nil
	}
	if err := removeRetiredClone(root); err != nil {
		return rep, err
	}
	rep.CloneRemoved = append(rep.CloneRemoved, retiredCloneRel)
	return rep, nil
}
