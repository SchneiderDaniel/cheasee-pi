package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
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
	if _, err := os.Stat(filepath.Join(workdir, ".bare")); err != nil {
		t.Error("init must bare-clone into <workdir>/.bare")
	}
	if _, err := os.Stat(filepath.Join(workdir, "main", "cheasee-settings.json")); err != nil {
		t.Error("init must scaffold cheasee-settings.json in the worktree leaf")
	}
	if _, err := os.Stat(filepath.Join(workdir, "main", "docker")); !os.IsNotExist(err) {
		t.Error("init must not extract docker/ into the worktree (CLI cache dir owns compose)")
	}
}

func TestRunInit_OverviewAndPlainPrompts(t *testing.T) {
	// User-journey: an interactive GitHub-flow run prints the workflow
	// overview before the first prompt, then drives both prompts with
	// plain-language titles/placeholders/hints.
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubInitGit(t)

	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}

	var calls *[]promptCall
	deps := initDepsWithRepoURL(t, workdir, func(d *InitDeps) {
		var input func(string, string) (string, error)
		input, calls = captureInputFn(t, "owner/repo", "main")
		d.InputFn = input
	})
	stderr := testutil.CaptureStderr(t, func() {
		if err := runInit(context.Background(), deps); err != nil {
			t.Fatalf("GitHub flow failed: %v", err)
		}
	})

	// Overview content: empty-dir reassurance, workspace clone, aut"h/keys,
	// start hand-off, escape hatch.
	for _, want := range []string{"init runs only in an empty directory", "--no-github", "cheasee-pi start"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr should contain overview fragment %q, got:\n%s", want, stderr)
		}
	}
	// Ordered narration: overview → repo hint → folder-name hint → completion.
	idx := func(frag string) int { return strings.Index(stderr, frag) }
	if idx("init runs only in an empty directory") < 0 || idx("init runs only in an empty directory") > idx("must already exist on GitHub") {
		t.Error("overview must precede the repo-URL hint")
	}
	if idx("must already exist on GitHub") > idx("not a git branch") {
		t.Error("repo-URL hint must precede the folder-name hint")
	}
	if idx("not a git branch") > idx("Init complete!") {
		t.Error("folder-name hint must precede the completion message")
	}

	// New plain-language titles + placeholders reach the InputFn seam.
	wantCalls := []promptCall{
		{title: "GitHub repo pi should work on", placeholder: "owner/repo"},
		{title: "Workspace folder name", placeholder: "main"},
	}
	if !slices.Equal(*calls, wantCalls) {
		t.Errorf("InputFn calls = %+v, want %+v", *calls, wantCalls)
	}

	// Repo hint explains clone/mount without duplicating the old placeholder.
	for _, want := range []string{".bare", "worktree", "must already exist on GitHub"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("repo hint should mention %q, got:\n%s", want, stderr)
		}
	}
	if strings.Contains(stderr, "https://github.com/owner/repo") {
		t.Error("repo hint/placeholder must not carry the old full-URL placeholder")
	}
	// Folder-name hint corrects the git-branch fabrication.
	for _, want := range []string{"workspace subfolder", "not a git branch"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("folder-name hint should mention %q, got:\n%s", want, stderr)
		}
	}
}

func TestRunInit_NoInputSkipsOverview(t *testing.T) {
	// --no-input GitHub flow (--repo-url set): no prompts → no overview
	// narration (clig.dev no-prompts rule).
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubInitGit(t)

	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = true
		d.RepoURL = "owner/repo"
	})
	stderr := testutil.CaptureStderr(t, func() {
		if err := runInit(context.Background(), deps); err != nil {
			t.Fatalf("--no-input GitHub flow failed: %v", err)
		}
	})
	if strings.Contains(stderr, "init runs only in an empty directory") {
		t.Errorf("--no-input must not print the overview, got:\n%s", stderr)
	}
}

func TestRunInit_NoGitHubSkipsOverview(t *testing.T) {
	// Interactive --no-github legacy flow: API-key only, no clone to explain
	// → no overview; the legacy mode notice still prints.
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoGitHub = true
		d.NoInput = false
		d.APIKey = FakeAPIKey
		d.ConfirmFn = mockConfirmFn(false, nil)
	})
	stderr := testutil.CaptureStderr(t, func() {
		if err := runInit(context.Background(), deps); err != nil {
			t.Fatalf("legacy interactive flow failed: %v", err)
		}
	})
	if strings.Contains(stderr, "init runs only in an empty directory") {
		t.Errorf("--no-github must not print the overview, got:\n%s", stderr)
	}
	if !strings.Contains(stderr, "API-key-only mode") {
		t.Errorf("legacy flow must still announce API-key-only mode, got:\n%s", stderr)
	}
}

func TestRunInit_ReauthSkipsOverview(t *testing.T) {
	// Reauth short-circuits after the probe gate — it never reaches the
	// overview (no clone/workspace copy to explain).
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"oauth":{"clientID":"app-123"}}`)

	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.Reauth = true
		d.NoInput = false
		d.ConfirmFn = mockConfirmFn(true, nil, "Configure API keys")
	})
	stderr := testutil.CaptureStderr(t, func() {
		if err := runInit(context.Background(), deps); err != nil {
			t.Fatalf("reauth flow failed: %v", err)
		}
	})
	if strings.Contains(stderr, "init runs only in an empty directory") {
		t.Errorf("reauth must not print the overview, got:\n%s", stderr)
	}
}

func TestRunInit_NonEmptyFolderSkipsOverview(t *testing.T) {
	// The empty-folder probe refuses before the overview would print — a
	// refusal never carries workflow narration.
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
	})
	var err error
	stderr := testutil.CaptureStderr(t, func() {
		err = runInit(context.Background(), deps)
	})
	if err == nil || !strings.Contains(err.Error(), "empty folder") {
		t.Fatalf("expected empty-folder refusal, got %v", err)
	}
	if strings.Contains(stderr, "init runs only in an empty directory") {
		t.Errorf("refusal must not print the overview, got:\n%s", stderr)
	}
}

func TestInitCmd_RepoURLFlagHelpPlainLanguage(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "init", "--help")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(output, "GitHub repo pi should work on") {
		t.Errorf("--repo-url help should use plain-language wording, got:\n%s", output)
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
