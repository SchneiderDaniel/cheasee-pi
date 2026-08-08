package main

import (
	"context"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"strings"
	"testing"
)

func TestInitCmd_HelpShowsNewFlags(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "init", "--help")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	expectedFlags := []string{"--workdir", "--source-repo", "--no-github", "--client-id", "--provider", "--skip-fork", "--fork-url", "--no-input"}
	for _, flag := range expectedFlags {
		if !strings.Contains(output, flag) {
			t.Errorf("init --help output should show %q flag", flag)
		}
	}
}

func TestSourceForkMode_Constants(t *testing.T) {
	// Verify all three are distinct
	if ModePromptFork == ModeUseForkURL || ModePromptFork == ModeSkipFork || ModeUseForkURL == ModeSkipFork {
		t.Error("SourceForkMode constants must be distinct")
	}
}

func TestSourceForkInput_Defaults(t *testing.T) {
	sfi := SourceForkInput{}
	if sfi.Mode != ModePromptFork {
		t.Errorf("expected ModePromptFork (0), got %d", sfi.Mode)
	}
	if sfi.SourceRepo != "" {
		t.Errorf("expected empty SourceRepo, got %q", sfi.SourceRepo)
	}
	if sfi.ForkURL != "" {
		t.Errorf("expected empty ForkURL, got %q", sfi.ForkURL)
	}
}

func TestSourceForkInput_RoundTrip(t *testing.T) {
	sfi := SourceForkInput{
		Mode:       ModeUseForkURL,
		SourceRepo: "user/repo",
		ForkURL:    "https://github.com/user/repo.git",
	}
	if sfi.Mode != ModeUseForkURL {
		t.Errorf("expected ModeUseForkURL, got %d", sfi.Mode)
	}
	if sfi.SourceRepo != "user/repo" {
		t.Errorf("expected 'user/repo', got %q", sfi.SourceRepo)
	}
	if sfi.ForkURL != "https://github.com/user/repo.git" {
		t.Errorf("expected fork URL, got %q", sfi.ForkURL)
	}
}

func TestRunInitPromptSource_EmptyInputDefaults(t *testing.T) {
	result, err := runInitPromptSource(SourceForkInput{Mode: ModePromptFork})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "SchneiderDaniel/cheasee-pi" {
		t.Errorf("expected default 'SchneiderDaniel/cheasee-pi', got %q", result)
	}
}

func TestRunInitPromptSource_UserInput(t *testing.T) {
	result, err := runInitPromptSource(SourceForkInput{Mode: ModePromptFork, SourceRepo: "user/repo"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "user/repo" {
		t.Errorf("expected 'user/repo', got %q", result)
	}
}

func TestRunInitPromptSource_NoInputFlag(t *testing.T) {
	result, err := runInitPromptSource(SourceForkInput{Mode: ModePromptFork})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "SchneiderDaniel/cheasee-pi" {
		t.Errorf("expected default, got %q", result)
	}
}

func TestRunInitPromptSource_SourceRepoFlag(t *testing.T) {
	result, err := runInitPromptSource(SourceForkInput{Mode: ModePromptFork, SourceRepo: "org/custom"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "org/custom" {
		t.Errorf("expected 'org/custom', got %q", result)
	}
}

func TestRunInitPromptSource_ForkURLMode(t *testing.T) {
	result, err := runInitPromptSource(SourceForkInput{Mode: ModeUseForkURL, ForkURL: "https://github.com/user/existing-fork.git"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "user/existing-fork" {
		t.Errorf("expected 'user/existing-fork', got %q", result)
	}
}

func TestRunInit_SkipFork(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.SourceFork = SourceForkInput{Mode: ModeSkipFork}
		d.Workdir = workdir
	}))
	if err != nil {
		t.Fatalf("skip-fork flow failed: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called after skip-fork flow")
	}
}

func TestRunInit_ForkURL(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	// Capture the CloneWorktree seam args (git clone --bare <authURL> <dir>)
	var cloneURL string
	savedRun := runCommandContext
	runCommandContext = func(_ context.Context, _ string, arg ...string) runner {
		if len(arg) > 0 && arg[0] == "clone" {
			cloneURL = arg[2]
			return &mockCmd{}
		}
		if len(arg) > 0 && arg[0] == "version" {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte("24.0.9"), nil }}
		}
		return &mockCmd{}
	}
	defer func() { runCommandContext = savedRun }()

	ports := defaultMocks()

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Ports = ports
		d.SourceFork = SourceForkInput{Mode: ModeUseForkURL, ForkURL: "https://github.com/user/existing-fork.git"}
		d.Workdir = workdir
	}))
	if err != nil {
		t.Fatalf("fork-url flow failed: %v", err)
	}
	if cloneURL == "" {
		t.Error("CloneWorktree should be called with fork URL")
	}
	if cloneURL != "https://oauth2:"+FakeGitHubToken+"@github.com/user/existing-fork.git" {
		t.Errorf("expected tokenized clone URL, got %q", cloneURL)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called after fork-url flow")
	}
}

func TestRunInit_ForkURLSkipsCreateFork(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	forkCalled := false
	waitForkCalled := false
	mockGH := &mockGitHubClient{
		getUserFunc: func(ctx context.Context, token string) (string, error) {
			return "testuser", nil
		},
		createForkFunc: func(ctx context.Context, token, sourceOwner, sourceRepo string) (string, error) {
			forkCalled = true
			return "testuser/cheasee-pi", nil
		},
		waitForkFunc: func(ctx context.Context, token, owner, repo string) error {
			waitForkCalled = true
			return nil
		},
	}

	mockAuth := &mockAuthenticator{}
	ports := defaultMocks()
	ports.Auth = mockAuth
	ports.GitHub = mockGH

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Ports = ports
		d.SourceFork = SourceForkInput{Mode: ModeUseForkURL, ForkURL: "https://github.com/user/existing-fork.git"}
		d.Workdir = workdir
	}))
	if err != nil {
		t.Fatalf("fork-url flow failed: %v", err)
	}
	if forkCalled {
		t.Error("CreateFork should NOT be called when --fork-url is used")
	}
	if waitForkCalled {
		t.Error("WaitForkReady should NOT be called when --fork-url is used")
	}
}

func TestRunInit_ForkURLInvalid(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.SourceFork = SourceForkInput{Mode: ModeUseForkURL, ForkURL: ""}
		d.Workdir = workdir
	}))
	if err == nil {
		t.Fatal("expected error for invalid fork URL")
	}
	if !strings.Contains(err.Error(), "invalid clone URL") {
		t.Errorf("error should mention invalid clone URL: %v", err)
	}
}

func TestRunInit_PostCloneConfirm_Accepted(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoInput = false
		d.SourceFork = SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}
		d.Workdir = workdir
		d.ConfirmFn = mockConfirmFn(true, nil, "Configure API keys")
	}))
	if err != nil {
		t.Fatalf("post-clone confirm flow failed: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called when confirm is accepted")
	}
}

func TestRunInit_PostCloneConfirm_Declined(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoInput = false
		d.SourceFork = SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}
		d.Workdir = workdir
		d.ConfirmFn = mockConfirmFn(false, nil)
	}))
	if err != nil {
		t.Fatalf("expected nil error (clean exit) when confirm is declined: %v", err)
	}
	if authJSONExists(t) {
		t.Error("Save should NOT be called when confirm is declined")
	}
}

func TestRunInit_PostCloneConfirm_NoInputSkipsPrompt(t *testing.T) {
	// With noInput=true, the post-clone confirm should be skipped
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	// If confirm were called with false, we'd error (but it won't be called)
	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.SourceFork = SourceForkInput{Mode: ModePromptFork, SourceRepo: "owner/cheasee-pi"}
		d.Workdir = workdir
		d.ConfirmFn = nil
	}))
	if err != nil {
		t.Fatalf("post-clone confirm with noInput=true failed: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called when noInput skips prompt")
	}
}
