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

	expectedFlags := []string{"--workdir", "--no-github", "--client-id", "--provider", "--no-input", "--api-key", "--no-docker-check", "--repo-url"}
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

func TestRunInit_GitHubFlowClonesWorktree(t *testing.T) {
	// GitHub flow: docker check + URL input + OAuth + bare clone + worktree +
	// cheasee-settings.json scaffold + save. Nothing is extracted into the
	// workdir (compose stays in the CLI cache dir).
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	clone := stubInitGit(t)

	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	err := runInit(context.Background(), initDepsWithRepoURL(t, workdir))
	if err != nil {
		t.Fatalf("GitHub flow failed: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called after the flow")
	}
	if len(clone.cloneArgs) != 1 || len(clone.worktreeAdd) != 1 {
		t.Fatalf("expected one bare clone + one worktree add, got %d/%d", len(clone.cloneArgs), len(clone.worktreeAdd))
	}
	if _, err := os.Stat(filepath.Join(parent, ".bare")); err != nil {
		t.Error("init must bare-clone into <parent>/.bare")
	}
	if _, err := os.Stat(filepath.Join(workdir, "cheasee-settings.json")); err != nil {
		t.Error("init must scaffold cheasee-settings.json at the folder root")
	}
	if _, err := os.Stat(filepath.Join(workdir, "docker")); !os.IsNotExist(err) {
		t.Error("init must not extract docker/ into the workdir (CLI cache dir owns compose)")
	}
	if _, err := os.Stat(filepath.Join(workdir, ".initremove")); !os.IsNotExist(err) {
		t.Error("init must not create .initremove")
	}
}

func TestRunInit_NoGitHubLegacySkipsGitInit(t *testing.T) {
	// --no-github path: API key only, no clone, no URL prompt, no git init;
	// the dedicated cheasee-settings.json is scaffolded.
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
	if _, err := os.Stat(filepath.Join(workdir, "cheasee-settings.json")); err != nil {
		t.Errorf("cheasee-settings.json should have been scaffolded: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, ".pi", "settings.json")); !os.IsNotExist(err) {
		t.Error("--no-github must not scaffold .pi/settings.json")
	}
}
