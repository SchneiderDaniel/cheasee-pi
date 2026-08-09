package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestInitCmd_HelpShowsNewFlags(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "init", "--help")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	expectedFlags := []string{"--workdir", "--no-github", "--client-id", "--provider", "--no-input", "--api-key", "--no-docker-check"}
	for _, flag := range expectedFlags {
		if !strings.Contains(output, flag) {
			t.Errorf("init --help output should show %q flag", flag)
		}
	}
}

func TestInitCmd_RemovedFlagsRejected(t *testing.T) {
	// The fork/clone phase is gone — its flags must be rejected by cobra.
	for _, flag := range []string{"--source-repo", "--skip-fork", "--fork-url"} {
		_, err := testutil.RunCobra(t, rootCmd, "init", flag, "x")
		if err == nil {
			t.Errorf("removed flag %q should be rejected by cobra", flag)
		}
	}
}

func TestRunInit_ScaffoldOnlyNoClone(t *testing.T) {
	// GitHub flow: docker check + OAuth + scaffold + save. Nothing is cloned,
	// forked, extracted, or git-inited into the workdir.
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.Workdir = workdir }))
	if err != nil {
		t.Fatalf("scaffold-only flow failed: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called after the flow")
	}
	if _, err := os.Stat(filepath.Join(workdir, "docker")); !os.IsNotExist(err) {
		t.Error("init must not extract docker/ into the workdir (CLI cache dir owns compose)")
	}
	if _, err := os.Stat(filepath.Join(workdir, ".git")); !os.IsNotExist(err) {
		t.Error("init must not git-init the workdir (user runs from their own repo)")
	}
	if _, err := os.Stat(filepath.Join(workdir, ".initremove")); !os.IsNotExist(err) {
		t.Error("init must not create .initremove")
	}
}

func TestRunInit_NoGitHubLegacySkipsGitInit(t *testing.T) {
	// --no-github path: API key only, scaffold + save — no git init.
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
		d.Workdir = workdir
	}))
	if err != nil {
		t.Fatalf("legacy path failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, ".git")); !os.IsNotExist(err) {
		t.Error("--no-github must not git-init the workdir")
	}
	if _, err := os.Stat(filepath.Join(workdir, ".pi", "settings.json")); err != nil {
		t.Errorf("scaffold should have run (.pi/settings.json missing): %v", err)
	}
}
