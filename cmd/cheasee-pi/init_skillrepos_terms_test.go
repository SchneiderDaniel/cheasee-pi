package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestRunInitSkillRepos_NoInputNoFlagsRecordsNothing(t *testing.T) {
	// --no-input without --skill-repo: no default repository exists any more, so
	// the phase records nothing and performs no Save — the settings file stays
	// byte-identical.
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	deps := initDeps(t, func(d *InitDeps) { d.Workdir = workdir }) // NoInput defaults true
	if err := runInitSkillRepos(deps); err != nil {
		t.Fatalf("no-input no-flag: %v", err)
	}
	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.SkillRepos) != 0 {
		t.Errorf("no-input without flags must record no repo, got %v", s.SkillRepos)
	}
	data, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{}` {
		t.Errorf("no-op must not rewrite the settings file, got %s", data)
	}
}

func TestRunInitSkillRepos_NoInputFlagsRecorded(t *testing.T) {
	// --no-input with repeated --skill-repo: all flag specs recorded, no prompt.
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.SkillRepos = []string{"owner/repo", "git:github.com/x/y"}
	})
	if err := runInitSkillRepos(deps); err != nil {
		t.Fatalf("no-input with flags: %v", err)
	}
	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://github.com/owner/repo", "git:github.com/x/y"}
	if len(s.SkillRepos) != 2 || s.SkillRepos[0] != want[0] || s.SkillRepos[1] != want[1] {
		t.Errorf("skillRepos = %v, want %v", s.SkillRepos, want)
	}
}

func TestRunInitSkillRepos_FlagsPreseedDeduped(t *testing.T) {
	// Flag-provided specs pre-seed the interactive loop; duplicates between
	// flags and prompt input are deduped.
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	confirm, input := mockQueuePrompt(t, []bool{true, false}, []string{"owner/repo"})
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		d.SkillRepos = []string{"owner/repo"}
		d.ConfirmFn = confirm
		d.InputFn = input
	})
	if err := runInitSkillRepos(deps); err != nil {
		t.Fatalf("pre-seeded loop: %v", err)
	}
	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://github.com/owner/repo"}
	if len(s.SkillRepos) != 1 || s.SkillRepos[0] != want[0] {
		t.Errorf("skillRepos = %v, want %v (flag/prompt dupes collapsed)", s.SkillRepos, want)
	}
}

func TestRunInitSkillRepos_InvalidFlagSpecFailsBeforePrompt(t *testing.T) {
	// A bad --skill-repo value fails fast even in interactive mode — before
	// the first prompt fires.
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		d.SkillRepos = []string{"npm:whatever"}
		d.ConfirmFn = func(string) (bool, error) { t.Error("no prompt may fire for a bad flag spec"); return false, nil }
	})
	err := runInitSkillRepos(deps)
	if err == nil || !strings.Contains(err.Error(), "npm:") {
		t.Fatalf("expected npm: rejection, got %v", err)
	}
}

// ──────────────────────────────────────────────
// Terminology contract (one consistent term: "skills")
// ──────────────────────────────────────────────

// TestInitHelp_TerminologyContract guards the init help surface (initCmd Long
// + --skill-repo flag usage): the artifact term "skills" is defined exactly
// once on the help page, "extension"/"package" never appear, and the stable
// identifiers (command Use/Short, flag name) stay byte-unchanged.
func TestInitHelp_TerminologyContract(t *testing.T) {
	// Long item 7 carries the definition at its first help-page mention.
	item7 := "  7. Ask for custom skills (reusable instruction sets for pi) to install\n" +
		"     into the container from git-hosted skill repositories, recorded in\n" +
		"     cheasee-settings.json skillRepos"
	if !strings.Contains(initCmd.Long, item7) {
		t.Errorf("init Long item 7 must read:\n%s\ngot Long:\n%s", item7, initCmd.Long)
	}
	if got := strings.Count(initCmd.Long, "skills (reusable instruction sets for pi)"); got != 1 {
		t.Errorf("definition must appear exactly once in init Long, got %d", got)
	}
	if strings.Contains(initCmd.Long, "git packages via pi") {
		t.Error("init Long must not reference 'git packages via pi'")
	}

	// --skill-repo usage uses the same term without re-defining it (same
	// help page) and no longer calls the artifact a "repository".
	flag := initCmd.Flags().Lookup("skill-repo")
	if flag == nil {
		t.Fatal("--skill-repo flag must still exist")
	}
	usage := flag.Usage
	wantUsage := "Custom skills to install into the container (repeatable; owner/repo, https://…, or git:host/user/repo[@ref])"
	if usage != wantUsage {
		t.Errorf("--skill-repo usage = %q, want %q", usage, wantUsage)
	}
	if strings.Contains(usage, "reusable instruction sets") {
		t.Error("--skill-repo usage must not repeat the definition (same help page as Long)")
	}

	// One-term promise: no extension/package wording anywhere on the help
	// surface, and the pre-change flag text is gone.
	termRe := regexp.MustCompile(`(?i)\b(extensions?|packages?)\b`)
	for _, s := range []struct{ name, text string }{
		{"init Long", initCmd.Long},
		{"--skill-repo usage", usage},
	} {
		if termRe.MatchString(s.text) {
			t.Errorf("%s must not use extension/package wording, got: %s", s.name, s.text)
		}
		if strings.Contains(s.text, "Custom skill repository to install") {
			t.Errorf("%s must not carry the old flag text 'Custom skill repository to install', got: %s", s.name, s.text)
		}
	}

	// Regression: command identity and flag name byte-unchanged.
	if initCmd.Use != "init" || initCmd.Short != "Initialize cheasee-pi configuration" {
		t.Errorf("init Use/Short must be byte-unchanged, got %q / %q", initCmd.Use, initCmd.Short)
	}
}

// TestRunInitSkillRepos_TerminologyContract guards the interactive surface
// (runInitSkillRepos header/body): the header prints 🧩 Custom Skills, the
// body defines "skills" exactly once and still names the delivery forms and
// stop condition, "extension"/"package" wording is gone, and the confirm
// prompt / input label stay byte-unchanged.
func TestRunInitSkillRepos_TerminologyContract(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	var confirmTitles, inputTitles []string
	confirm := func(title string) (bool, error) {
		confirmTitles = append(confirmTitles, title)
		return true, nil
	}
	input := func(title, _ string) (string, error) {
		inputTitles = append(inputTitles, title)
		return "   ", nil // whitespace input = silent done signal
	}
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		d.ConfirmFn = confirm
		d.InputFn = input
	})
	output := testutil.CaptureStderr(t, func() {
		if err := runInitSkillRepos(deps); err != nil {
			t.Fatalf("terminology flow: %v", err)
		}
	})

	if !strings.Contains(output, "🧩 Custom Skills") {
		t.Errorf("header must print 🧩 Custom Skills, got: %q", output)
	}
	if got := strings.Count(output, "Skills (reusable instruction sets for pi)"); got != 1 {
		t.Errorf("body must define skills exactly once, got %d: %q", got, output)
	}
	for _, gone := range []string{"Skill/extension repos", "via pi's git package mechanism"} {
		if strings.Contains(output, gone) {
			t.Errorf("body must not contain %q, got: %q", gone, output)
		}
	}
	for _, keep := range []string{
		"pi install -l → .pi/git/",
		"owner/repo",
		"https://…",
		"git:host/user/repo[@ref]",
		"answer no (or leave the input empty) to stop",
		"`pi uninstall`", // the generic removal path stays documented
		"skills can include code the agent may run",
	} {
		if !strings.Contains(output, keep) {
			t.Errorf("body must still name %q, got: %q", keep, output)
		}
	}
	// No installed default and no package slug may be advertised.
	for _, gone := range []string{"Installed by default", "DietrichGebert"} {
		if strings.Contains(output, gone) {
			t.Errorf("body must not contain %q, got: %q", gone, output)
		}
	}

	// Regression: prompt/label wording byte-unchanged.
	if len(confirmTitles) != 1 || confirmTitles[0] != "Add a custom skill repository?" {
		t.Errorf("confirm prompt must be byte-unchanged, got %v", confirmTitles)
	}
	if len(inputTitles) != 1 || inputTitles[0] != "Skill repository" {
		t.Errorf("input label must be byte-unchanged, got %v", inputTitles)
	}
}
