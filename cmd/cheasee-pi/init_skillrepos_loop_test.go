package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestRunInitSkillRepos_InteractiveLoop(t *testing.T) {
	// ConfirmFn yes → InputFn spec → canonicalize + record → repeat;
	// ConfirmFn false terminates with nil error. Entry order is preserved.
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	confirm, input := mockQueuePrompt(t, []bool{true, true, false}, []string{"owner/repo", "git:github.com/x/y"})
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		d.ConfirmFn = confirm
		d.InputFn = input
	})
	if err := runInitSkillRepos(deps); err != nil {
		t.Fatalf("interactive loop: %v", err)
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

func TestRunInitSkillRepos_EmptyInputStopsLoop(t *testing.T) {
	// Empty/whitespace InputFn input is the silent done signal — it stops the
	// loop and records nothing.
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	confirm, input := mockQueuePrompt(t, []bool{true}, []string{"   "})
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		d.ConfirmFn = confirm
		d.InputFn = input
	})
	if err := runInitSkillRepos(deps); err != nil {
		t.Fatalf("empty input: %v", err)
	}
	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.SkillRepos) != 0 {
		t.Errorf("empty input must stop the loop and record nothing, got %v", s.SkillRepos)
	}
	data, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{}` {
		t.Errorf("no-op must not rewrite the settings file, got %s", data)
	}
}

func TestRunInitSkillRepos_InvalidSpecFailsFast(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	confirm, input := mockQueuePrompt(t, []bool{true}, []string{"not a repo"})
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		d.ConfirmFn = confirm
		d.InputFn = input
	})
	err := runInitSkillRepos(deps)
	if err == nil {
		t.Fatal("invalid spec must fail fast")
	}
	if !strings.Contains(err.Error(), "not a repo") {
		t.Errorf("error must name the spec, got: %v", err)
	}
	if !strings.Contains(err.Error(), "owner/repo") {
		t.Errorf("error should name the accepted forms, got: %v", err)
	}
}

func TestRunInitSkillRepos_PromptErrorWrapped(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	confirm := func(string) (bool, error) { return false, errors.New("confirm boom") }
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		d.ConfirmFn = confirm
	})
	err := runInitSkillRepos(deps)
	if err == nil || !strings.Contains(err.Error(), "skill repo prompt") {
		t.Fatalf("expected wrapped 'skill repo prompt' error, got %v", err)
	}

	input := func(string, string) (string, error) { return "", errors.New("input boom") }
	deps = initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		d.ConfirmFn = mockConfirmFn(true, nil)
		d.InputFn = input
	})
	err = runInitSkillRepos(deps)
	if err == nil || !strings.Contains(err.Error(), "skill repo prompt") {
		t.Fatalf("expected wrapped 'skill repo prompt' error for InputFn, got %v", err)
	}
}

func TestRunInitSkillRepos_LeavesExistingCustomUntouched(t *testing.T) {
	// An existing cheasee-settings.json whose skillRepos holds a custom repo is
	// left exactly as it is: init seeds no repository of its own.
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"skillRepos":["https://github.com/SchneiderDaniel/private-pi.git"]}`)
	deps := initDeps(t, func(d *InitDeps) { d.Workdir = workdir }) // NoInput defaults true
	if err := runInitSkillRepos(deps); err != nil {
		t.Fatalf("existing custom repo: %v", err)
	}
	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://github.com/SchneiderDaniel/private-pi.git"}
	if len(s.SkillRepos) != 1 || s.SkillRepos[0] != want[0] {
		t.Errorf("skillRepos = %v, want %v", s.SkillRepos, want)
	}
}
