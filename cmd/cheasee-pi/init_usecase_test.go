package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestInitUseCase_DockerNotInstalled(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubLookPath(t, func(_ string) (string, error) { return "", fmt.Errorf("executable not found in $PATH") })

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.NoGitHub = true }))
	if err == nil {
		t.Fatal("expected error when Docker not installed")
	}
	if !strings.Contains(err.Error(), "Docker is not installed") {
		t.Errorf("error should mention Docker is not installed: %v", err)
	}
	if authJSONExists(t) {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerNotRunning(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, fmt.Errorf("Cannot connect to the Docker daemon"), "", nil)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.NoGitHub = true }))
	if err == nil {
		t.Fatal("expected error when Docker not running")
	}
	if !strings.Contains(err.Error(), "not running") {
		t.Errorf("error should mention Docker not running: %v", err)
	}
	if authJSONExists(t) {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerVersionTooOld(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "23.0.0", nil)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.NoGitHub = true }))
	if err == nil {
		t.Fatal("expected error when Docker version too old")
	}
	if !strings.Contains(err.Error(), "Docker") {
		t.Errorf("error should mention Docker: %v", err)
	}
	if authJSONExists(t) {
		t.Error("Save should not be called when Docker check fails")
	}
}

func TestInitUseCase_DockerCheckReturnsErr(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "", fmt.Errorf("version check failed"))

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.NoGitHub = true }))
	if err == nil {
		t.Fatal("expected error when Docker version fetch fails")
	}
	if !strings.Contains(err.Error(), "Docker version check") {
		t.Errorf("error should mention Docker version check: %v", err)
	}
}

func TestInitUseCase_NoDockerCheckFlag(t *testing.T) {
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.NoDockerCheck = true
		d.APIKey = FakeAPIKey
	}))
	if err != nil {
		t.Fatalf("unexpected error with --no-docker-check: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called when --no-docker-check is set")
	}
	if got := loadAuthJSON(t).APIKey; got != FakeAPIKey {
		t.Errorf("expected saved key %q, got %q", FakeAPIKey, got)
	}
}

func TestInitUseCase_HappyPathWithAPIKeyFlag(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err != nil {
		t.Fatalf("unexpected error on happy path: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called on happy path")
	}
	if got := loadAuthJSON(t).APIKey; got != FakeAPIKey {
		t.Errorf("expected API key %q, got %q", FakeAPIKey, got)
	}
}

func TestInitUseCase_ConfigSaveError(t *testing.T) {
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	// Block the config dir path with a regular file so MkdirAll fails
	// deterministically (real file I/O, no mock error injection).
	dir := testutil.RedirectConfigHome(t)
	if err := os.WriteFile(filepath.Join(dir, "cheasee-pi"), []byte("block"), 0644); err != nil {
		t.Fatalf("block config dir: %v", err)
	}

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err == nil {
		t.Fatal("expected error when Save fails")
	}
	if !strings.Contains(err.Error(), "save auth config") {
		t.Errorf("error should wrap with 'save auth config': %v", err)
	}
}

func TestInitUseCase_ContextCancelled(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled

	err := runInit(ctx, initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err == nil {
		t.Fatal("expected error with cancelled context")
	}
	if !strings.Contains(err.Error(), "context") {
		t.Errorf("error should mention context cancellation: %v", err)
	}
}

func TestInitProbe_Empty(t *testing.T) {
	mode, err := runInitProbe(t.TempDir(), false)
	if err != nil {
		t.Fatalf("empty dir must proceed, got: %v", err)
	}
	if mode != initModeFull {
		t.Errorf("empty dir without --reauth must select the full flow, got %v", mode)
	}
}

func TestInitProbe_DSStoreOnlyProceeds(t *testing.T) {
	// Finder-touched folders (.DS_Store only) auto-init.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".DS_Store"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	mode, err := runInitProbe(dir, false)
	if err != nil {
		t.Fatalf(".DS_Store-only dir must proceed, got: %v", err)
	}
	if mode != initModeFull {
		t.Errorf("expected full mode, got %v", mode)
	}
}

func TestInitProbe_NonEmptyRefuses(t *testing.T) {
	// Hard refusal — no confirm prompt, no re-apply question.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := runInitProbe(dir, false)
	if err == nil || !strings.Contains(err.Error(), "empty folder") {
		t.Fatalf("non-empty dir must refuse with an empty-folder-only error, got: %v", err)
	}
	if !strings.Contains(err.Error(), "file.txt") {
		t.Errorf("refusal should name the offending entry, got: %v", err)
	}
}

func TestInitProbe_SettingsPresentRefuses(t *testing.T) {
	// cheasee-settings.json presence = initialized marker — no re-apply prompt.
	dir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, dir, `{"defaultProvider": "openai"}`)
	_, err := runInitProbe(dir, false)
	if err == nil || !strings.Contains(err.Error(), "already initialized") {
		t.Fatalf("settings present must refuse as already initialized, got: %v", err)
	}
	if !strings.Contains(err.Error(), "cheasee-pi start") {
		t.Errorf("refusal should point at `cheasee-pi start`, got: %v", err)
	}
	if !strings.Contains(err.Error(), "--reauth") {
		t.Errorf("refusal should name `--reauth`, got: %v", err)
	}
}

func TestInitProbe_SettingsPresentWithReauthSelectsReauth(t *testing.T) {
	dir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, dir, `{}`)
	mode, err := runInitProbe(dir, true)
	if err != nil {
		t.Fatalf("settings present + --reauth must proceed, got: %v", err)
	}
	if mode != initModeReauth {
		t.Errorf("expected reauth mode, got %v", mode)
	}
}

func TestInitProbe_SettingsPresentWithReauthSkipsEmptyFolderProbe(t *testing.T) {
	// On an initialized workspace the empty-folder probe is skipped — the
	// workspace has files by design.
	dir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, dir, `{}`)
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	mode, err := runInitProbe(dir, true)
	if err != nil {
		t.Fatalf("settings present + --reauth must skip the empty-folder probe, got: %v", err)
	}
	if mode != initModeReauth {
		t.Errorf("expected reauth mode, got %v", mode)
	}
}

func TestInitProbe_ReauthInertWithoutSettings(t *testing.T) {
	// --reauth without settings: flag is inert — full mode on empty dirs,
	// unchanged empty-folder refusal on non-empty dirs.
	empty := t.TempDir()
	mode, err := runInitProbe(empty, true)
	if err != nil {
		t.Fatalf("--reauth on an empty dir without settings must proceed full, got: %v", err)
	}
	if mode != initModeFull {
		t.Errorf("expected full mode, got %v", mode)
	}

	nonEmpty := t.TempDir()
	if err := os.WriteFile(filepath.Join(nonEmpty, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := runInitProbe(nonEmpty, true); err == nil || !strings.Contains(err.Error(), "empty folder") {
		t.Fatalf("--reauth without settings on a non-empty dir must keep the empty-folder refusal, got: %v", err)
	}
}

func TestInitUseCase_PostCloneFailureCleansResidue(t *testing.T) {
	// A post-clone init failure (API-key phase) removes the freshly cloned
	// worktree + sibling .bare, announces the cleanup, and leaves the folder
	// empty — otherwise both init (non-empty probe) and start (WorkspaceRefuse)
	// would refuse the stranded folder.
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	stubInitGit(t)

	deps := initDepsWithRepoURL(t, workdir, func(d *InitDeps) {
		d.ConfirmFn = mockConfirmFn(false, fmt.Errorf("declined"))
	})
	stderr := testutil.CaptureStderr(t, func() {
		err := runInit(context.Background(), deps)
		// The first post-clone prompt is now the skill-repo phase (Phase 6b,
		// before the API-key phase) — the failure surfaces there.
		if err == nil || !strings.Contains(err.Error(), "skill repo setup") {
			t.Fatalf("expected skill-repo setup failure, got %v", err)
		}
	})

	if !strings.Contains(stderr, "removing incomplete workspace residue") {
		t.Errorf("cleanup must be announced to stderr, got: %q", stderr)
	}
	if _, statErr := os.Stat(workdir); !os.IsNotExist(statErr) {
		t.Errorf("post-clone failure must remove the worktree: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(parent, ".bare")); !os.IsNotExist(statErr) {
		t.Errorf("post-clone failure must remove .bare: %v", statErr)
	}
}

func TestInitUseCase_PreCloneFailureLeavesNoResidue(t *testing.T) {
	// Pre-clone failure (device-flow/auth error) → no cleanup call and no
	// .bare created (nothing to remove).
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)

	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		d.InputFn = mockInputFn("owner/repo", nil)
		d.Ports = InitPorts{Auth: &mockAuthenticator{
			waitFunc: func(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error) {
				return nil, fmt.Errorf("device flow wait failed: user cancelled")
			},
		}}
	})

	err := runInit(context.Background(), deps)
	if err == nil || !strings.Contains(err.Error(), "GitHub authentication failed") {
		t.Fatalf("expected auth failure, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(parent, ".bare")); !os.IsNotExist(statErr) {
		t.Errorf("pre-clone failure must leave no .bare: %v", statErr)
	}
}

func TestInitUseCase_NonEmptyRefusesEvenWithNoInput(t *testing.T) {
	// The empty-folder contract is a hard refusal — --no-input does not bypass it.
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err == nil || !strings.Contains(err.Error(), "empty folder") {
		t.Fatalf("expected empty-folder refusal, got %v", err)
	}
	if authJSONExists(t) {
		t.Error("no auth must be saved when the folder is refused")
	}
}

func TestInitUseCase_SettingsPresentRefusesEvenWithNoInput(t *testing.T) {
	// cheasee-settings.json presence = initialized marker — init refuses,
	// --no-input or not (no re-apply flow).
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err == nil || !strings.Contains(err.Error(), "already initialized") {
		t.Fatalf("expected already-initialized refusal, got %v", err)
	}
}

func TestInitUseCase_UnparsableRepoURLErrorsBeforeGit(t *testing.T) {
	// An unparsable repo URL must fail before any git call (no partial clone).
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	var gitCalls int
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "git" {
			gitCalls++
		}
		return saved(ctx, name, arg...)
	})

	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		d.InputFn = mockInputFn("not-a-url", nil)
	}))
	if err == nil || !strings.Contains(err.Error(), "invalid repo URL") {
		t.Fatalf("expected invalid repo URL error, got %v", err)
	}
	if gitCalls != 0 {
		t.Errorf("no git call may run for an unparsable URL, got %d", gitCalls)
	}
	if _, statErr := os.Stat(filepath.Join(parent, ".bare")); !os.IsNotExist(statErr) {
		t.Errorf("no .bare may be created for an unparsable URL: %v", statErr)
	}
}

func TestInitUseCase_NoInputRequiresRepoURL(t *testing.T) {
	// --no-input without --repo-url and without --no-github errors before
	// any git call (there is no prompt to ask for the URL).
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	var gitCalls int
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "git" {
			gitCalls++
		}
		return saved(ctx, name, arg...)
	})

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.Workdir = workdir }))
	if err == nil || !strings.Contains(err.Error(), "--repo-url") {
		t.Fatalf("expected --repo-url requirement error, got %v", err)
	}
	if gitCalls != 0 {
		t.Errorf("no git call may run without a repo URL, got %d", gitCalls)
	}
}

// ──────────────────────────────────────────────
// Custom skill repositories (init Phase 6b)
// ──────────────────────────────────────────────

func TestInitUseCase_SkillReposInteractiveFlow(t *testing.T) {
	// User journey: repo URL prompt → clone → "Add a custom skill
	// repository?" → enter DietrichGebert/ponytail → done → init complete;
	// cheasee-settings.json carries the canonical skillRepos entry.
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	stubInitGit(t)

	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	deps := skillRepoFlowDeps(t, workdir, []bool{true, false}, []string{"owner/repo", "DietrichGebert/ponytail"})
	if err := runInit(context.Background(), deps); err != nil {
		t.Fatalf("full interactive flow: %v", err)
	}
	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://github.com/DietrichGebert/ponytail"}
	if len(s.SkillRepos) != 1 || s.SkillRepos[0] != want[0] {
		t.Errorf("skillRepos = %v, want %v", s.SkillRepos, want)
	}
}

func TestInitUseCase_NoSkillReposScaffoldByteIdentical(t *testing.T) {
	// Full flow without skill repos: the skill-repo phase records nothing and
	// performs no Save — cheasee-settings.json stays byte-identical to the
	// scaffold template output.
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	stubInitGit(t)

	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	deps := skillRepoFlowDeps(t, workdir, []bool{false}, []string{"owner/repo"})
	if err := runInit(context.Background(), deps); err != nil {
		t.Fatalf("flow without skill repos: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got), "skillRepos") {
		t.Errorf("no skill repos → no skillRepos key, got: %s", got)
	}

	// Baseline: the embedded template rendered with the exact values
	// runInitScaffold used (identity from SetGitConfig, defaults, canonical
	// repo URL, resolved GitHub user).
	baseline := t.TempDir()
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), baseline, TemplateSettingsValues{
		Provider:      deps.Provider,
		DefaultModel:  DefaultModel(deps.Provider),
		GitName:       "Test User",
		GitEmail:      "test@example.com",
		Memory:        "2G",
		CPUs:          "2.0",
		ClientID:      deps.ClientID,
		RepositoryURL: "https://github.com/owner/repo.git",
		GitHubUser:    MockGitHubUser,
	}); err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(filepath.Join(baseline, "cheasee-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Errorf("no-skill-repos flow must leave the scaffold output byte-identical:\n got: %s\nwant: %s", got, want)
	}
}

func TestInitUseCase_NoInputSkillRepoFlagsNoPrompts(t *testing.T) {
	// --no-input + repeated --skill-repo: no prompt fires, canonical specs
	// are persisted.
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	stubInitGit(t)

	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.RepoURL = "owner/repo"
		d.SkillRepos = []string{"owner/repo"}
		d.ConfirmFn = func(string) (bool, error) { t.Error("no confirm prompt allowed with --no-input"); return false, nil }
		d.InputFn = func(string, string) (string, error) {
			t.Error("no input prompt allowed with --no-input")
			return "", nil
		}
	})
	if err := runInit(context.Background(), deps); err != nil {
		t.Fatalf("no-input flow: %v", err)
	}
	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://github.com/owner/repo"}
	if len(s.SkillRepos) != 1 || s.SkillRepos[0] != want[0] {
		t.Errorf("skillRepos = %v, want %v", s.SkillRepos, want)
	}
}

func TestInitUseCase_NoGitHubRecordsSkillRepos(t *testing.T) {
	// The skill-repo phase is not gated on the GitHub clone flow — the legacy
	// --no-github path records flag-provided specs too.
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)

	workdir := t.TempDir()
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
		d.SkillRepos = []string{"owner/repo"}
	})
	if err := runInit(context.Background(), deps); err != nil {
		t.Fatalf("legacy flow: %v", err)
	}
	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://github.com/owner/repo"}
	if len(s.SkillRepos) != 1 || s.SkillRepos[0] != want[0] {
		t.Errorf("skillRepos = %v, want %v", s.SkillRepos, want)
	}
}

func TestInitUseCase_ReauthLeavesSkillReposUntouched(t *testing.T) {
	// --reauth on an initialized workspace: no skill-repo prompt, no
	// re-record — the existing skillRepos array survives untouched.
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)

	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"skillRepos": ["https://github.com/a/b"]}`)
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = true
		d.NoGitHub = true
		d.Reauth = true
	})
	if err := runInit(context.Background(), deps); err != nil {
		t.Fatalf("reauth: %v", err)
	}
	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.SkillRepos) != 1 || s.SkillRepos[0] != "https://github.com/a/b" {
		t.Errorf("reauth must leave skillRepos untouched, got %v", s.SkillRepos)
	}
}

func TestInitUseCase_SkillRepoFailureCleansResidue(t *testing.T) {
	// A post-clone failure in the skill-repo phase (invalid spec entered)
	// runs removeInitResidue — worktree + sibling .bare removed, cleanup
	// announced on stderr.
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	stubInitGit(t)

	deps := skillRepoFlowDeps(t, workdir, []bool{true}, []string{"owner/repo", "not a repo"})
	stderr := testutil.CaptureStderr(t, func() {
		err := runInit(context.Background(), deps)
		if err == nil || !strings.Contains(err.Error(), "skill repo setup") {
			t.Fatalf("expected skill-repo failure, got %v", err)
		}
	})
	if !strings.Contains(stderr, "removing incomplete workspace residue") {
		t.Errorf("cleanup must be announced to stderr, got: %q", stderr)
	}
	if _, statErr := os.Stat(workdir); !os.IsNotExist(statErr) {
		t.Errorf("post-clone failure must remove the worktree: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(parent, ".bare")); !os.IsNotExist(statErr) {
		t.Errorf("post-clone failure must remove .bare: %v", statErr)
	}
}

func TestInitUseCase_SkillRepoAnnouncementBetweenScaffoldAndAuthSave(t *testing.T) {
	// The skill-repo step announcement appears on stderr between the scaffold
	// line and the auth-save line; the completion message is unchanged.
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	stubInitGit(t)

	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	deps := skillRepoFlowDeps(t, workdir, []bool{false}, []string{"owner/repo"})
	output := testutil.CaptureStderr(t, func() {
		if err := runInit(context.Background(), deps); err != nil {
			t.Fatalf("flow: %v", err)
		}
	})
	scaffoldIdx := strings.Index(output, "cheasee-settings.json created")
	announceIdx := strings.Index(output, "Custom Skill Repositories")
	authIdx := strings.Index(output, "Auth config saved to")
	if scaffoldIdx < 0 || announceIdx < 0 || authIdx < 0 {
		t.Fatalf("expected scaffold + announcement + auth-save lines, got: %q", output)
	}
	if !(scaffoldIdx < announceIdx && announceIdx < authIdx) {
		t.Errorf("announcement must sit between scaffold and auth-save (indices %d/%d/%d)", scaffoldIdx, announceIdx, authIdx)
	}
	if !strings.Contains(output, "✅ Init complete") {
		t.Error("completion message must be unchanged (✅ Init complete)")
	}
}
