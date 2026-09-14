package main

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// destructiveShorts are the four destructive commands' Short strings — the
// surface a user skims in `cheasee-pi --help`. Each must disclose its blast
// radius in words a skimmer cannot miss (down = this workspace, clean +
// prune-images = host-wide, uninstall = the tool itself).
var destructiveShorts = []struct {
	name    string
	short   string
	markers []string
}{
	{"down", downCmd.Short, []string{"THIS workspace"}},
	{"clean", cleanCmd.Short, []string{"ALL", "kills active sessions"}},
	{"prune-images", pruneImagesCmd.Short, []string{"ALL", "recreated"}},
	{"uninstall", uninstallCmd.Short, []string{"itself"}},
}

// TestDestructiveCmdShort_DisclosesBlastRadius pins the blast-radius
// disclosure: nothing else binds Short text, so a future edit could silently
// re-soften clean's wording without any test noticing.
func TestDestructiveCmdShort_DisclosesBlastRadius(t *testing.T) {
	for _, tc := range destructiveShorts {
		for _, m := range tc.markers {
			if !strings.Contains(tc.short, m) {
				t.Errorf("%s Short %q must disclose blast radius with %q", tc.name, tc.short, m)
			}
		}
	}
}

// TestDestructiveCmdShort_Within80Runes guards the 80-col overflow pitfall:
// cobra's default usage template prints Short with no word-wrap, so anything
// beyond 80 runes overflows the terminal in `cheasee-pi --help`.
func TestDestructiveCmdShort_Within80Runes(t *testing.T) {
	for _, tc := range destructiveShorts {
		if n := utf8.RuneCountInString(tc.short); n > 80 {
			t.Errorf("%s Short is %d runes (> 80) and would overflow the help command list", tc.name, n)
		}
	}
}

// TestDestructiveCmdShort_WellFormed pins the style contract: non-empty,
// no trailing period (capital-initial like every existing Short).
func TestDestructiveCmdShort_WellFormed(t *testing.T) {
	for _, tc := range destructiveShorts {
		if tc.short == "" {
			t.Errorf("%s Short must be non-empty", tc.name)
		}
		if strings.HasSuffix(tc.short, ".") {
			t.Errorf("%s Short %q must not end with a period", tc.name, tc.short)
		}
	}
}

// TestRootCmd_HelpListsDestructiveShorts proves cobra renders the
// blast-radius text into the command list a user actually skims.
func TestRootCmd_HelpListsDestructiveShorts(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "--help")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, tc := range destructiveShorts {
		if !strings.Contains(output, tc.short) {
			t.Errorf("cheasee-pi --help should list %s's blast-radius Short %q", tc.name, tc.short)
		}
	}
}
