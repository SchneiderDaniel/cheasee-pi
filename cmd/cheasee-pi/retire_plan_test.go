package main

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
)

// Phase 1: planRetirement, the pure classifier — no fs, no docker, no pi.
// ──────────────────────────────────────────────

// TestRetiredPackageConstants pins the two fingerprints the migration matches
// on. They are literals on purpose: a future removal of the migration must
// break this test instead of silently leaving a variant behind.
func TestRetiredPackageConstants(t *testing.T) {
	if retiredPackageSource != ponytailSource {
		t.Errorf("retiredPackageSource = %q, want the recorded package source %q", retiredPackageSource, ponytailSource)
	}
	if retiredCloneRel != ponytailClonePath {
		t.Errorf("retiredCloneRel = %q, want the checkout path %q", retiredCloneRel, ponytailClonePath)
	}
	if retiredSkillFilter != "!ponytail-*" {
		t.Errorf("retiredSkillFilter = %q, want %q", retiredSkillFilter, "!ponytail-*")
	}
}

// rawPackages decodes a table row's package literals the way the settings file
// hands them to planRetirement: undecoded JSON elements.
func rawPackages(t *testing.T, literals []string) []json.RawMessage {
	t.Helper()
	elems := make([]json.RawMessage, 0, len(literals))
	for _, lit := range literals {
		elems = append(elems, json.RawMessage(lit))
	}
	return elems
}

// entryLabels renders plan entries as `slice[index]`, sorted, so a table row can
// name exactly which elements the plan selected without restating the struct
// (or the order the two loops happen to produce).
func entryLabels(entries []retireEntry) []string {
	labels := make([]string, 0, len(entries))
	for _, e := range entries {
		where := "packages"
		if e.Kind == retireEntrySkillRepo {
			where = "skillRepos"
		}
		labels = append(labels, fmt.Sprintf("%s[%d]", where, e.Index))
	}
	slices.Sort(labels)
	return labels
}

// sameLabels compares a plan's entries with a table row's expectation, treating
// a nil slice and an empty expectation as equal.
func sameLabels(got, want []string) bool {
	if len(got) == 0 && len(want) == 0 {
		return true
	}
	return slices.Equal(got, want)
}

// TestPlanRetirement_Classification is the decision table: which registration
// shape may go without asking, which one needs --confirm, which one is never
// matched, plus whether the clone may follow.
func TestPlanRetirement_Classification(t *testing.T) {
	cases := []struct {
		name        string
		packages    []string
		skillRepos  []string
		wantAuto    []string
		wantConfirm []string
		// wantCloneRemovable is "nothing left references the retired repo once
		// the plan's auto removals land".
		wantCloneRemovable bool
	}{
		{
			name:               "object fingerprint is removed on its own",
			packages:           []string{stalePackageObject},
			wantAuto:           []string{"packages[0]"},
			wantCloneRemovable: true,
		},
		{
			name:               "bare string plus the skillRepos seed is the harness provenance pair",
			packages:           []string{stalePackageBare},
			skillRepos:         []string{retiredPackageSource},
			wantAuto:           []string{"packages[0]", "skillRepos[0]"},
			wantCloneRemovable: true,
		},
		{
			name:        "bare string without provenance needs confirmation",
			packages:    []string{stalePackageBare},
			wantConfirm: []string{"packages[0]"},
			// The entry stays registered, so the checkout it resolves to must
			// stay with it.
			wantCloneRemovable: false,
		},
		{
			name:               "skillRepos seed alone is removed",
			skillRepos:         []string{retiredPackageSource},
			wantAuto:           []string{"skillRepos[0]"},
			wantCloneRemovable: true,
		},
		{
			name:               "object with a wildcard skills filter is a user edit",
			packages:           []string{`{"source": "` + ponytailSource + `", "skills": ["*"]}`},
			wantCloneRemovable: false,
		},
		{
			name:               "object with an extra skills filter is a user edit",
			packages:           []string{`{"source": "` + ponytailSource + `", "skills": ["!ponytail-*", "!other-*"]}`},
			wantCloneRemovable: false,
		},
		{
			name:               "object without a skills filter names no fingerprint",
			packages:           []string{`{"source": "` + ponytailSource + `"}`},
			wantCloneRemovable: false,
		},
		{
			name: "source variants are left verbatim",
			packages: []string{
				`"` + ponytailSource + `.git"`,
				`"` + ponytailSource + `@v1"`,
				`"` + ponytailSource + `/"`,
				`"DietrichGebert/ponytail"`,
				`"HTTPS://GITHUB.COM/DietrichGebert/ponytail"`,
			},
			wantCloneRemovable: false,
		},
		{
			name: "unrelated entries are never matched",
			packages: []string{
				`"` + keptPackageSource + `"`,
				`{"source": "` + keptPackageSource + `", "skills": ["!kept-*"]}`,
				`{"source": "https://github.com/DietrichGebert/ponytail-extras"}`,
			},
			skillRepos: []string{keptSkillRepo},
			// Nothing references the retired repo, so a leftover checkout of an
			// earlier failed run is still reclaimable.
			wantCloneRemovable: true,
		},
		{
			name:               "non-string non-object elements are preserved",
			packages:           []string{`7`, `["a"]`, `null`, `true`},
			wantCloneRemovable: true,
		},
		{
			name:               "empty inputs",
			wantCloneRemovable: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan, err := planRetirement(rawPackages(t, tc.packages), tc.skillRepos)
			if err != nil {
				t.Fatalf("planRetirement: %v", err)
			}
			if got := entryLabels(plan.Auto); !sameLabels(got, tc.wantAuto) {
				t.Errorf("Auto = %v, want %v", got, tc.wantAuto)
			}
			if got := entryLabels(plan.NeedsConfirm); !sameLabels(got, tc.wantConfirm) {
				t.Errorf("NeedsConfirm = %v, want %v", got, tc.wantConfirm)
			}
			if plan.CloneRemovable != tc.wantCloneRemovable {
				t.Errorf("CloneRemovable = %v, want %v", plan.CloneRemovable, tc.wantCloneRemovable)
			}
		})
	}
}

// TestPlanRetirement_EmptyInputsZeroPlan pins the nil/empty inputs: no entries
// and no error. CloneRemovable is true because nothing references the retired
// repo — that is exactly what makes a rerun converge on a clone an earlier
// failed run left behind.
func TestPlanRetirement_EmptyInputsZeroPlan(t *testing.T) {
	for _, tc := range []struct {
		name       string
		packages   []json.RawMessage
		skillRepos []string
	}{
		{"nil slices", nil, nil},
		{"empty slices", []json.RawMessage{}, []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			plan, err := planRetirement(tc.packages, tc.skillRepos)
			if err != nil {
				t.Fatalf("planRetirement: %v", err)
			}
			if len(plan.Auto) != 0 || len(plan.NeedsConfirm) != 0 {
				t.Errorf("empty inputs must plan no entries, got %v / %v",
					entryLabels(plan.Auto), entryLabels(plan.NeedsConfirm))
			}
			if !plan.CloneRemovable {
				t.Error("CloneRemovable must be true — nothing references the retired repo")
			}
		})
	}
}

// TestPlanRetirement_NonStringSourceFailsClosed covers the one element the
// classifier cannot reason about: an object whose "source" is not a JSON
// string. Guessing would risk touching user data, so the plan fails instead.
func TestPlanRetirement_NonStringSourceFailsClosed(t *testing.T) {
	_, err := planRetirement([]json.RawMessage{json.RawMessage(`{"source": 7}`)}, nil)
	if err == nil {
		t.Fatal("planRetirement must reject an object whose source is not a string")
	}
	if !strings.Contains(err.Error(), "source") {
		t.Errorf("error must name the offending field, got %v", err)
	}
}
