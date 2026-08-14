package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

func TestInitCmd_HelpShowsNewFlags(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "init", "--help")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	expectedFlags := []string{"--workdir", "--no-github", "--client-id", "--provider", "--no-input", "--api-key", "--no-docker-check", "--repo-url", "--reauth", "--skill-repo"}
	for _, flag := range expectedFlags {
		if !strings.Contains(output, flag) {
			t.Errorf("init --help output should show %q flag", flag)
		}
	}
}

func TestRunInitE_ReauthFlagSetsDeps(t *testing.T) {
	// --reauth maps into InitDeps.Reauth; without the flag it stays false.
	cmd := &cobra.Command{Use: "init"}
	cmd.Flags().BoolVar(&initReauth, "reauth", false, "")
	cmd.Flags().StringVar(&initClientID, "client-id", "178c6fc778ccc68e1d6a", "")
	cmd.SetArgs([]string{"--reauth"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute --reauth: %v", err)
	}
	deps := resolveInitDeps(cmd, t.TempDir(), InitDeps{})
	if !deps.Reauth {
		t.Error("--reauth must set InitDeps.Reauth")
	}

	// Without --reauth the flag var must stay false (a prior run may have
	// set it — cobra does not reset bound vars on re-execution).
	old := initReauth
	initReauth = false
	t.Cleanup(func() { initReauth = old })
	cmd.SetArgs(nil)
	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	deps = resolveInitDeps(cmd, t.TempDir(), InitDeps{})
	if deps.Reauth {
		t.Error("without --reauth, InitDeps.Reauth must be false")
	}
}

func TestRunInitE_SkillRepoFlagWiresDeps(t *testing.T) {
	// Repeated --skill-repo flows into InitDeps.SkillRepos via newInitDeps
	// (the shared factory both init entry points use).
	old := initSkillRepos
	initSkillRepos = nil
	t.Cleanup(func() { initSkillRepos = old })

	cmd := &cobra.Command{Use: "init"}
	cmd.Flags().StringArrayVar(&initSkillRepos, "skill-repo", nil, "")
	cmd.SetArgs([]string{"--skill-repo", "a/b", "--skill-repo", "git:github.com/c/d"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	deps := newInitDeps(t.TempDir())
	if len(deps.SkillRepos) != 2 || deps.SkillRepos[0] != "a/b" || deps.SkillRepos[1] != "git:github.com/c/d" {
		t.Errorf("SkillRepos = %v, want [a/b git:github.com/c/d]", deps.SkillRepos)
	}

	// Without the flag the var must stay nil (a prior run may have set it —
	// cobra does not reset bound vars on re-execution).
	initSkillRepos = nil
	cmd.SetArgs(nil)
	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute without flag: %v", err)
	}
	deps = newInitDeps(t.TempDir())
	if len(deps.SkillRepos) != 0 {
		t.Errorf("without --skill-repo, SkillRepos must be empty, got %v", deps.SkillRepos)
	}
}

func TestRunInitE_ReauthClientIDResolution(t *testing.T) {
	// Client-ID resolution on the reauth path: stored oauth.clientID from
	// cheasee-settings.json wins unless --client-id was explicitly changed;
	// explicit --client-id wins; no stored ID keeps the flag/default.
	cases := []struct {
		name         string
		settings     string // "" = no settings file
		clientFlag   bool
		wantClientID string
		wantExplicit bool
	}{
		{"stored oauth.clientID wins without explicit flag", `{"oauth":{"clientID":"stored-app"}}`, false, "stored-app", false},
		{"explicit --client-id wins over stored", `{"oauth":{"clientID":"stored-app"}}`, true, "explicit-app", true},
		{"no stored ID keeps flag/default", "", false, "178c6fc778ccc68e1d6a", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			testutil.RedirectConfigHome(t)
			workdir := t.TempDir()
			if tc.settings != "" {
				testutil.WriteCheaseeSettingsFile(t, workdir, tc.settings)
			}
			cmd := &cobra.Command{Use: "init"}
			cmd.Flags().BoolVar(&initReauth, "reauth", false, "")
			cmd.Flags().StringVar(&initClientID, "client-id", "178c6fc778ccc68e1d6a", "")
			args := []string{"--reauth"}
			if tc.clientFlag {
				args = append(args, "--client-id", "explicit-app")
			}
			cmd.SetArgs(args)
			if err := cmd.Execute(); err != nil {
				t.Fatalf("execute: %v", err)
			}

			// Base mirrors what newInitDeps produces: the flag-bound var value.
			base := InitDeps{ClientID: initClientID, Ports: InitPorts{Auth: &mockAuthenticator{}}}
			got := resolveInitDeps(cmd, workdir, base)
			if got.ClientID != tc.wantClientID {
				t.Errorf("ClientID = %q, want %q", got.ClientID, tc.wantClientID)
			}
			if got.ClientIDExplicit != tc.wantExplicit {
				t.Errorf("ClientIDExplicit = %v, want %v", got.ClientIDExplicit, tc.wantExplicit)
			}
			if !tc.clientFlag && tc.settings != "" {
				da, ok := got.Ports.Auth.(*deviceFlowAuthenticator)
				if !ok {
					t.Fatalf("stored-clientID resolution must rebuild the real authenticator, got %T", got.Ports.Auth)
				}
				if da.clientID != "stored-app" {
					t.Errorf("authenticator clientID = %q, want stored-app", da.clientID)
				}
			}
		})
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
