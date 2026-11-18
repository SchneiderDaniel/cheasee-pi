package main

// Retirement of the deprecated Ponytail package (#2137).
//
// The container bind-mounts the host workspace, so rebuilding the image never
// replaces the `.pi/settings.json` pi loads from that mount: a workspace created
// by an older release keeps loading a package the harness no longer ships.
// Filtering the extension or hiding its footer at runtime would not fix that —
// the registration would stay, and pi loads whatever a registration records.
//
// This is the supported, idempotent migration instead: a state-based
// reconciliation that removes exactly the deprecated registrations and exactly
// the checkout behind them, and touches nothing else.
//
// Two files have to be cleaned, not one. `embedded/docker/entrypoint.sh`
// `install_skill_repos` runs `pi install -l -a` for every `cheasee-settings.json`
// skillRepos spec on every container start, so dropping only the `packages`
// entry would be reverted on the next start. That is also why this runs on the
// host, before the container starts, instead of inside the entrypoint (which
// `entrypoint_skillrepos_test.go` additionally forbids from reading
// `.pi/settings.json`).
//
// The host editing pi's `packages` array is a deliberate, removal-only
// exception with precedent in SettingsWriter's `.pi/settings.json` update. pi
// keeps sole ownership of every write that adds or changes an entry.

const (
	// retiredPackageSource is the exact package source an earlier release
	// recorded. Only this spelling is matched: a variant (`.git` suffix, `@ref`
	// pin, trailing slash, shorthand, different host case) is not what the
	// harness wrote and is left for the operator.
	retiredPackageSource = "https://github.com/DietrichGebert/ponytail"

	// retiredSkillFilter is the skill filter the harness wrote next to the
	// source. The pair is the harness fingerprint: the same source with a
	// different filter is a user edit of the same package, never touched
	// automatically.
	retiredSkillFilter = "!ponytail-*"

	// retiredCloneRel is the project-local checkout `pi install -l` creates. It
	// is named exactly: the parent directory also holds user-installed skill
	// clones, so it is never removed.
	retiredCloneRel = ".pi/git/github.com/DietrichGebert/ponytail"

	// confirmHint is the exact follow-up an operator needs when the migration
	// cannot prove an entry is a harness leftover.
	confirmHint = "cheasee-pi migrate --confirm"
)

// retireOptions is one retirement run as the caller decided it. Confirm
// authorizes the entries the plan cannot classify on its own; DryRun only
// reports, and touches no file and no directory.
type retireOptions struct {
	Confirm bool
	DryRun  bool
}

// retireReport is what one run did — or, on a dry run, would do. Each slice
// holds the sources and paths it names, so a caller prints them verbatim
// instead of re-deriving what happened. A converged workspace yields the zero
// report and prints nothing.
type retireReport struct {
	Removed           []string
	NeedsConfirmation []string
	CloneRemoved      []string
}
