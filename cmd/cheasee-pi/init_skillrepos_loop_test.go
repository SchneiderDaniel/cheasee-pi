package main

import (
	"errors"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"strings"
	"testing"
)

func TestRunInitSkillRepos_InteractiveLoop(t *testing.T) {
	// ConfirmFn yes → InputFn spec → canonicalize + record → repeat;
	// ConfirmFn false terminates with nil error.
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
	want := []string{defaultSkillRepos[0], "https://github.com/owner/repo", "git:github.com/x/y"}
	if len(s.SkillRepos) != 3 || s.SkillRepos[0] != want[0] || s.SkillRepos[1] != want[1] || s.SkillRepos[2] != want[2] {
		t.Errorf("skillRepos = %v, want %v", s.SkillRepos, want)
	}
}

func TestRunInitSkillRepos_EmptyInputStopsLoop(t *testing.T) {
	// Empty/whitespace InputFn input is the silent done signal — it stops the
	// loop but still seeds the fixed default repo (ponytail).
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
	if len(s.SkillRepos) != 1 || s.SkillRepos[0] != defaultSkillRepos[0] {
		t.Errorf("empty input must stop the loop but seed the default repo, got %v", s.SkillRepos)
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

func TestRunInitSkillRepos_SeedsDefaultAlongsideExistingCustom(t *testing.T) {
	// Regression: an existing cheasee-settings.json whose skillRepos holds a
	// custom repo (private-pi) but not the fixed default (ponytail) must gain
	// ponytail — the scaffold skipped writing, so the default was lost.
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"skillRepos":["https://github.com/SchneiderDaniel/private-pi.git"]}`)
	deps := initDeps(t, func(d *InitDeps) { d.Workdir = workdir }) // NoInput defaults true
	if err := runInitSkillRepos(deps); err != nil {
		t.Fatalf("seed default: %v", err)
	}
	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"https://github.com/SchneiderDaniel/private-pi.git",
		defaultSkillRepos[0],
	}
	got := s.SkillRepos
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("skillRepos = %v, want %v", got, want)
	}
}
