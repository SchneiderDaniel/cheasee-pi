package main

import (
	"encoding/json"
	"slices"
)

// The pure half of the retirement: classification over decoded values, with no
// file, docker or pi access, so the whole decision table is testable without a
// temp workspace.

// retireEntryKind says which of the two settings files an entry lives in.
type retireEntryKind int

const (
	retireEntryPackage retireEntryKind = iota
	retireEntrySkillRepo
)

// retireEntry is one deprecated registration the plan will act on: what it
// names, which slice holds it, plus its index inside that slice.
type retireEntry struct {
	Kind   retireEntryKind
	Index  int
	Source string
}

// retirePlan is planRetirement's pure verdict: the entries safe to remove
// without asking, the ones that need explicit confirmation, plus whether the
// project-local checkout may go once those removals land.
type retirePlan struct {
	Auto           []retireEntry
	NeedsConfirm   []retireEntry
	CloneRemovable bool
}

// retireElement is one decoded element of pi's `packages` array: the source it
// names (empty when it names none) plus, for the object form, its skills
// filter list.
type retireElement struct {
	Source string
	Skills []string
	Object bool
}

// planRetirement classifies a workspace's registrations.
//
// Auto means the entry is provably a harness leftover:
//   - the object form carrying the retired source plus exactly the retired skill
//     filter (the fingerprint the harness wrote), or
//   - the exact source in `skillRepos` (the seed the harness wrote), or
//   - the bare string in `packages` while that seed is still present: the
//     harness wrote the two together, so the pair is its provenance.
//
// NeedsConfirm means the bare string without that provenance — it may be the
// user's own install, and the issue requires explicit consent rather than
// silently deleting user data.
func planRetirement(packages []json.RawMessage, skillRepos []string) (retirePlan, error) {
	elems, err := decodeRetireElements(packages)
	if err != nil {
		return retirePlan{}, err
	}

	var plan retirePlan
	seeded := false
	for i, spec := range skillRepos {
		if spec != retiredPackageSource {
			continue
		}
		seeded = true
		plan.Auto = append(plan.Auto, retireEntry{Kind: retireEntrySkillRepo, Index: i, Source: spec})
	}

	for i, elem := range elems {
		if elem.Source != retiredPackageSource {
			continue
		}
		if elem.Object {
			if slices.Equal(elem.Skills, []string{retiredSkillFilter}) {
				plan.Auto = append(plan.Auto, retireEntry{Kind: retireEntryPackage, Index: i, Source: elem.Source})
			}
			continue
		}
		if seeded {
			plan.Auto = append(plan.Auto, retireEntry{Kind: retireEntryPackage, Index: i, Source: elem.Source})
			continue
		}
		plan.NeedsConfirm = append(plan.NeedsConfirm, retireEntry{Kind: retireEntryPackage, Index: i, Source: elem.Source})
	}

	plan.CloneRemovable = planCloneRemoval(elems, skillRepos, plan.Auto)
	return plan, nil
}

// planCloneRemoval reports whether the project-local checkout may be deleted
// once the given entries are gone: nothing left in either slice may resolve to
// the same repository. That is what keeps a variant spelling — plus the clone it
// points at — alive.
func planCloneRemoval(elems []retireElement, skillRepos []string, removed []retireEntry) bool {
	removedPackages := make(map[int]bool, len(removed))
	removedRepos := make(map[int]bool, len(removed))
	for _, entry := range removed {
		if entry.Kind == retireEntrySkillRepo {
			removedRepos[entry.Index] = true
			continue
		}
		removedPackages[entry.Index] = true
	}

	target := normalizeRepoSource(retiredPackageSource)
	for i, elem := range elems {
		if removedPackages[i] || elem.Source == "" {
			continue
		}
		if normalizeRepoSource(elem.Source) == target {
			return false
		}
	}
	for i, spec := range skillRepos {
		if removedRepos[i] {
			continue
		}
		if normalizeRepoSource(spec) == target {
			return false
		}
	}
	return true
}
