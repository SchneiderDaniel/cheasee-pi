package main

import (
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// builtInCmds holds Cobra's built-in commands (help, completion); they are exempt
// from the RunE requirement since they are registered by Cobra itself.
var builtInCmds = map[string]bool{
	"help":       true,
	"completion": true,
}

func TestRootCmd_Use(t *testing.T) {
	if rootCmd.Use == "" {
		t.Error("rootCmd.Use must be non-empty")
	}
	if rootCmd.Short == "" {
		t.Error("rootCmd.Short must be non-empty")
	}
	if rootCmd.Long == "" {
		t.Error("rootCmd.Long must be non-empty")
	}
}

func TestRootCmd_HasInitSubcommand(t *testing.T) {
	found := false
	for _, c := range rootCmd.Commands() {
		if c.Name() == "init" {
			found = true
			break
		}
	}
	if !found {
		t.Error("rootCmd must have 'init' registered as a subcommand")
	}
}

func TestRootCmd_HelpContainsAppName(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "--help")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(output, rootCmd.Use) {
		t.Errorf("help output should contain app name %q", rootCmd.Use)
	}
}

// execRootHelp runs `cheasee-pi --help` through ExecuteC and returns the
// rendered output. ExecuteC registers cobra's help/completion commands with
// their setter-assigned group IDs and runs checkCommandGroups, which panics
// on any undefined GroupID — the typo safety net since cobra v1.7.

func execRootHelp(t *testing.T) string {
	t.Helper()
	output, err := testutil.RunCobra(t, rootCmd, "--help")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	return output
}

func TestRootCmd_AllCommandsGrouped(t *testing.T) {
	// ExecuteC first: it registers help/completion with their group IDs and
	// validates every GroupID (undefined ID => panic). No exemption allowlist:
	// a future command without a GroupID fails here mechanically.
	execRootHelp(t)
	if !rootCmd.AllChildCommandsHaveGroup() {
		t.Error("every child command must carry a GroupID (no 'Additional Commands:' stragglers)")
	}
	for _, id := range []string{groupIDGettingStarted, groupIDDailyUse, groupIDMaintenance, groupIDHelp} {
		if !rootCmd.ContainsGroup(id) {
			t.Errorf("rootCmd must contain group %q", id)
		}
	}
}

func TestRootCmd_GroupRenderOrder(t *testing.T) {
	want := []string{groupIDGettingStarted, groupIDDailyUse, groupIDMaintenance, groupIDHelp}
	groups := rootCmd.Groups()
	if len(groups) != len(want) {
		t.Fatalf("rootCmd has %d groups, want %d", len(groups), len(want))
	}
	for i, g := range groups {
		if g.ID != want[i] {
			t.Errorf("group %d = %q, want %q (AddGroup order = render order)", i, g.ID, want[i])
		}
	}
}

func TestRootCmd_GroupAssignment(t *testing.T) {
	execRootHelp(t)
	want := map[string]string{
		"init":         groupIDGettingStarted,
		"start":        groupIDGettingStarted,
		"about":        groupIDGettingStarted,
		"auth":         groupIDDailyUse,
		"clean":        groupIDDailyUse,
		"down":         groupIDDailyUse,
		"build":        groupIDMaintenance,
		"prune-images": groupIDMaintenance,
		"rebuild":      groupIDMaintenance,
		"uninstall":    groupIDMaintenance,
		"completion":   groupIDHelp,
		"help":         groupIDHelp,
	}
	seen := make(map[string]bool)
	for _, c := range rootCmd.Commands() {
		wantID, ok := want[c.Name()]
		if !ok {
			t.Errorf("command %q has no expected lifecycle group in the test table", c.Name())
			continue
		}
		if c.GroupID != wantID {
			t.Errorf("command %q GroupID = %q, want %q", c.Name(), c.GroupID, wantID)
		}
		seen[c.Name()] = true
	}
	for name := range want {
		if !seen[name] {
			t.Errorf("command %q missing from rootCmd.Commands()", name)
		}
	}
}

func TestRootCmd_HelpShowsGroupedLifecycle(t *testing.T) {
	output := execRootHelp(t)
	// Long/Short render above the usage block; the grouped command listing
	// lives inside it, so the ordering assertions are scoped to that tail.
	usageAt := strings.Index(output, "Usage:")
	if usageAt < 0 {
		t.Fatalf("help output must contain a usage block, got:\n%s", output)
	}
	tail := output[usageAt:]

	titles := []string{"Getting started", "Daily use", "Maintenance", "Help"}
	commandsByGroup := map[string][]string{
		"Getting started": {"about", "init", "start"},
		"Daily use":       {"auth", "clean", "down"},
		"Maintenance":     {"build", "prune-images", "rebuild", "uninstall"},
		"Help":            {"completion", "help"},
	}

	// Slice the tail into per-group sections by title position (titles render
	// in AddGroup order); then check each command sits under its own title.
	sections := make(map[string]string)
	pos := 0
	for i, title := range titles {
		start := strings.Index(tail[pos:], title)
		if start < 0 {
			t.Errorf("help output must render group title %q in order", title)
			continue
		}
		start += pos
		end := len(tail)
		if i+1 < len(titles) {
			if next := strings.Index(tail[start+1:], titles[i+1]); next >= 0 {
				end = start + 1 + next
			}
		}
		sections[title] = tail[start:end]
		pos = start + 1
	}

	// Within-group order is cobra's default alphabetical sort — pin the
	// membership only, not the reading order.
	for _, title := range titles {
		sec := sections[title]
		if sec == "" {
			continue // missing title already reported above
		}
		for _, name := range commandsByGroup[title] {
			if !strings.Contains(sec, "\n  "+name+" ") {
				t.Errorf("group %q must list %q under its title, section:\n%s", title, name, sec)
			}
		}
	}
}
