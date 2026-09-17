package main

import (
	"bytes"
	"fmt"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// builtInCmds are Cobra-internal commands (help, completion) that are exempt
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
		"Getting started": {"init", "start"},
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

func TestRootCmd_HelpNoAdditionalCommands(t *testing.T) {
	output := execRootHelp(t)
	for _, ghost := range []string{"Available Commands:", "Additional Commands:"} {
		if strings.Contains(output, ghost) {
			t.Errorf("grouped help must not render %q, got:\n%s", ghost, output)
		}
	}
}

func TestRootCmd_HelpContainsDocsLink(t *testing.T) {
	output := execRootHelp(t)
	if !strings.Contains(output, docsDailyUsageURL) {
		t.Errorf("help output must link the daily-usage docs (%s), got:\n%s", docsDailyUsageURL, output)
	}
}

func TestRootCmd_LongUsesCanonicalStart(t *testing.T) {
	if !strings.Contains(rootCmd.Long, "cheasee-pi start") {
		t.Error("rootCmd.Long must name the canonical 'cheasee-pi start' (not the stale 'up' alias)")
	}
	if strings.Contains(rootCmd.Long, "same as 'up'") {
		t.Error("rootCmd.Long must not reference the stale 'up' alias, which is not in the command list")
	}
	if !strings.Contains(rootCmd.Long, "Without a subcommand") {
		t.Error("rootCmd.Long must explain the no-arg auto-mode in a 'Without a subcommand' sentence")
	}
	// The no-arg explanation must cover all three folder states.
	for _, phrase := range []string{"empty", "cheasee-settings.json", "error"} {
		if !strings.Contains(rootCmd.Long, phrase) {
			t.Errorf("rootCmd.Long must cover the %q folder state in its no-arg explanation", phrase)
		}
	}
}

func TestRootCmd_HelpFirstTimeUserJourney(t *testing.T) {
	// Persona smoke: a first-time user with only `cheasee-pi --help` must be
	// able to answer (1) what the tool does, (2) how to start, (3) the daily
	// loop, (4) where the docs are — all from this single render.
	output := execRootHelp(t)
	for _, want := range []string{
		"pi coding agent",
		"Docker",
		"Getting started",
		"Daily use",
		"init",
		"start",
		"auth",
		"clean",
		"down",
		docsDailyUsageURL,
	} {
		if !strings.Contains(output, want) {
			t.Errorf("help output must mention %q for a first-time user, got:\n%s", want, output)
		}
	}
}

func TestRootCmd_NoRaspberryPiReference(t *testing.T) {
	if strings.Contains(rootCmd.Short, "Raspberry") {
		t.Error("rootCmd.Short must not reference Raspberry Pi")
	}
	if strings.Contains(rootCmd.Long, "Raspberry") {
		t.Error("rootCmd.Long must not reference Raspberry Pi")
	}
}

func TestRootCmd_UnknownFlagError(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "--unknown-flag")
	if err == nil {
		t.Error("expected error for unknown flag, got nil")
	}
	// SilenceUsage also suppresses the usage dump on flag/arg parse errors;
	// the error line itself remains the only guidance.
	if strings.Contains(output, "Usage:") || strings.Contains(output, "Available Commands:") {
		t.Errorf("flag errors must not dump the usage block, got:\n%s", output)
	}
}

func TestInitCmd_RunE(t *testing.T) {
	if initCmd.RunE == nil {
		t.Error("initCmd.RunE must be non-nil (use RunE, not Run)")
	}
}

func TestInitCmd_DisableAutoGenTag(t *testing.T) {
	if !initCmd.DisableAutoGenTag {
		t.Error("initCmd.DisableAutoGenTag should be true")
	}
}

func TestRootCmd_DisableAutoGenTag(t *testing.T) {
	if !rootCmd.DisableAutoGenTag {
		t.Error("rootCmd.DisableAutoGenTag should be true")
	}
}

func TestRootCmd_PersistentPreRunENil(t *testing.T) {
	if rootCmd.PersistentPreRunE != nil {
		t.Error("rootCmd.PersistentPreRunE must be nil (no hidden pre-run hooks)")
	}
}

func TestAllCommandsUseRunE(t *testing.T) {
	var check func(cmd *cobra.Command)
	check = func(cmd *cobra.Command) {
		t.Helper()
		if builtInCmds[cmd.Name()] {
			return
		}
		if cmd.RunE == nil && cmd.Run != nil {
			t.Errorf("command %q uses Run instead of RunE", cmd.Name())
		}
		for _, sub := range cmd.Commands() {
			check(sub)
		}
	}
	check(rootCmd)
}

func TestRootCmd_Version_IsNotStalePlaceholder(t *testing.T) {
	if rootCmd.Version == "0.1.0" {
		t.Errorf("rootCmd.Version is still the stale placeholder 0.1.0; update to %q", "1.0.0")
	}
}

func TestRootCmd_Version_NoVPrefix(t *testing.T) {
	if strings.HasPrefix(rootCmd.Version, "v") {
		t.Error("rootCmd.Version must not have a 'v' prefix (GoReleaser adds it in the tag, archive naming uses bare version)")
	}
}

func TestRootCmd_Version_IsValidSemver(t *testing.T) {
	v := rootCmd.Version
	if v == "" {
		t.Fatal("rootCmd.Version must not be empty")
	}
	// Semver validation: must match MAJOR.MINOR[.PATCH]
	parts := strings.Split(v, ".")
	if len(parts) < 2 || len(parts) > 3 {
		t.Errorf("rootCmd.Version %q is not valid semver (expected MAJOR.MINOR[.PATCH])", v)
	}
	for _, p := range parts {
		if p == "" {
			t.Errorf("rootCmd.Version %q has empty segment", v)
		}
		for _, c := range p {
			if c < '0' || c > '9' {
				t.Errorf("rootCmd.Version %q contains non-numeric segment %q", v, p)
			}
		}
	}
}

func TestRootCmd_Version_IsExpectedRelease(t *testing.T) {
	expected := "0.55.3"
	if rootCmd.Version != expected {
		t.Errorf("rootCmd.Version = %q, want %q", rootCmd.Version, expected)
	}
}

func TestInitCmd_HelpShowsFlags(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "init", "--help")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(output, "--api-key") {
		t.Errorf("init --help output should show --api-key flag\n--- output:\n%s", output)
	}
	if !strings.Contains(output, "--no-docker-check") {
		t.Errorf("init --help output should show --no-docker-check flag\n--- output:\n%s", output)
	}
}

// executeRootRunError drives the real rootCmd through cobra's ExecuteC on the
// docker-missing auto-init failure path (the issue's first-run scenario) with
// hermetic stdout/stderr buffers, returning both. Package tests are serialized
// (no t.Parallel), so mutating the package-global rootCmd is safe.
func executeRootRunError(t *testing.T) (string, string) {
	t.Helper()
	workdir := t.TempDir()
	setUpRunMode(t, workdir, false)
	stubLookPath(t, func(_ string) (string, error) { return "", fmt.Errorf("executable not found in $PATH") })

	// A prior RunCobra call (e.g. TestRootCmd_HelpContainsAppName's --help)
	// leaves the help flag value set on the shared rootCmd FlagSet — without a
	// reset the next ExecuteC short-circuits into a help print and returns nil.
	_ = rootCmd.Flags().Set("help", "false")
	var out, errOut bytes.Buffer
	rootCmd.SetOut(&out)
	rootCmd.SetErr(&errOut)
	// Explicit empty args keep ExecuteC off the os.Args fallback (under
	// `go test` that is the -test.* flags pflag silently swallows).
	rootCmd.SetArgs([]string{})
	_, err := rootCmd.ExecuteC()
	if err == nil {
		t.Fatal("expected a run error on the docker-missing auto-init path, got nil")
	}
	return out.String(), errOut.String()
}

func TestRootCmd_SilenceUsage_NoUsageOnRunError(t *testing.T) {
	t.Helper()
	out, _ := executeRootRunError(t)
	if strings.Contains(out, "Usage:") || strings.Contains(out, "Available Commands:") {
		t.Errorf("run errors must not dump the usage block, got:\n%s", out)
	}
}

func TestRootCmd_RunErrorPrintedOnce(t *testing.T) {
	// Guard against the double-print trap: SilenceErrors stays false and
	// main.go prints nothing, so cobra is the single "Error: " owner on stderr
	// — exactly one prefix carrying the docker-missing message.
	_, errOut := executeRootRunError(t)
	if got := strings.Count(errOut, "Error: "); got != 1 {
		t.Errorf("stderr must print the error exactly once, got %d 'Error: ' occurrences:\n%s", got, errOut)
	}
	if !strings.Contains(errOut, "Docker is not installed") {
		t.Errorf("stderr must carry the docker-missing message, got:\n%s", errOut)
	}
}
