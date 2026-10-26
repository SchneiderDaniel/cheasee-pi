package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// Custom skill repositories (init Phase 6b)
// ──────────────────────────────────────────────

func TestInitUseCase_SkillReposInteractiveFlow(t *testing.T) {
	// User journey: repo URL prompt → clone → "Add a custom skill
	// repository?" → enter some-org/skill-pack → done → init complete;
	// cheasee-settings.json carries the canonical skillRepos entry.
	stubInitFlow(t)

	_, workdir := newWorkspace(t)
	deps := skillRepoFlowDeps(t, workdir, []bool{true, false}, []string{"owner/repo", "main", "some-org/skill-pack"})
	if err := runInit(context.Background(), deps); err != nil {
		t.Fatalf("full interactive flow: %v", err)
	}
	s, err := LoadCheaseeSettings(filepath.Join(workdir, "main"))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://github.com/some-org/skill-pack"}
	if len(s.SkillRepos) != 1 || s.SkillRepos[0] != want[0] {
		t.Errorf("skillRepos = %v, want %v", s.SkillRepos, want)
	}
}

func TestInitUseCase_SkillReposInteractiveMultiAdd(t *testing.T) {
	// "You can add several": the prompt loop records every entered spec, not
	// just the first — two confirms + two specs → both canonical URLs in
	// cheasee-settings.json skillRepos.
	stubInitFlow(t)

	_, workdir := newWorkspace(t)
	deps := skillRepoFlowDeps(t, workdir, []bool{true, true, false}, []string{"owner/repo", "main", "some-org/skill-pack", "some-org/another-skill"})
	if err := runInit(context.Background(), deps); err != nil {
		t.Fatalf("full interactive flow: %v", err)
	}
	s, err := LoadCheaseeSettings(filepath.Join(workdir, "main"))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://github.com/some-org/skill-pack", "https://github.com/some-org/another-skill"}
	if len(s.SkillRepos) != len(want) {
		t.Fatalf("skillRepos = %v, want %v", s.SkillRepos, want)
	}
	for i, w := range want {
		if s.SkillRepos[i] != w {
			t.Errorf("skillRepos[%d] = %q, want %q (full: %v)", i, s.SkillRepos[i], w, s.SkillRepos)
		}
	}
}

func TestInitUseCase_NoSkillReposScaffoldByteIdentical(t *testing.T) {
	// Full flow without user skill repos: the skill-repo phase records nothing
	// and performs no Save — cheasee-settings.json stays byte-identical to the
	// scaffold template output, which carries no skillRepos key at all.
	stubInitFlow(t)

	_, workdir := newWorkspace(t)
	deps := skillRepoFlowDeps(t, workdir, []bool{false}, []string{"owner/repo"})
	if err := runInit(context.Background(), deps); err != nil {
		t.Fatalf("flow without skill repos: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(workdir, "main", "cheasee-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got), "skillRepos") {
		t.Errorf("scaffold must carry no skillRepos key, got: %s", got)
	}

	// Baseline: the embedded template rendered with the exact values
	// runInitScaffold used (identity from SetGitConfig, defaults, canonical
	// repo URL, resolved GitHub user, no skill repos).
	baseline := t.TempDir()
	if err := NewCheaseeSettingsScaffold().Scaffold(context.Background(), baseline, TemplateSettingsValues{
		Provider:      deps.Provider,
		DefaultModel:  DefaultModel(deps.Provider),
		GitName:       "Test User",
		GitEmail:      "test@example.com",
		Memory:        "5G",
		CPUs:          "4.0",
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
	stubInitFlow(t)

	_, workdir := newWorkspace(t)
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
	output := testutil.CaptureStderr(t, func() {
		if err := runInit(context.Background(), deps); err != nil {
			t.Fatalf("no-input flow: %v", err)
		}
	})
	if strings.Contains(output, "Installed by default") {
		t.Errorf("--no-input must skip the interactive prompt block entirely, got: %q", output)
	}
	s, err := LoadCheaseeSettings(filepath.Join(workdir, "main"))
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
	_, workdir := newWorkspace(t)
	stubInitFlow(t)

	deps := skillRepoFlowDeps(t, workdir, []bool{true}, []string{"owner/repo", "main", "not a repo"})
	stderr := testutil.CaptureStderr(t, func() {
		err := runInit(context.Background(), deps)
		if err == nil || !strings.Contains(err.Error(), "skill repo setup") {
			t.Fatalf("expected skill-repo failure, got %v", err)
		}
	})
	if !strings.Contains(stderr, "removing incomplete workspace residue") {
		t.Errorf("cleanup must be announced to stderr, got: %q", stderr)
	}
	if _, statErr := os.Stat(filepath.Join(workdir, "main")); !os.IsNotExist(statErr) {
		t.Errorf("post-clone failure must remove the worktree: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(workdir, ".bare")); !os.IsNotExist(statErr) {
		t.Errorf("post-clone failure must remove .bare: %v", statErr)
	}
}

func TestInitUseCase_SkillRepoAnnouncementBetweenScaffoldAndAuthSave(t *testing.T) {
	// The skill-repo step announcement appears on stderr between the scaffold
	// line and the auth-save line; the completion message is unchanged.
	stubInitFlow(t)

	_, workdir := newWorkspace(t)
	deps := skillRepoFlowDeps(t, workdir, []bool{false}, []string{"owner/repo"})
	output := testutil.CaptureStderr(t, func() {
		if err := runInit(context.Background(), deps); err != nil {
			t.Fatalf("flow: %v", err)
		}
	})
	scaffoldIdx := strings.Index(output, "cheasee-settings.json created")
	announceIdx := strings.Index(output, "Custom Skills")
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

func TestInitUseCase_SkillRepoPromptDeclaresNoDefault(t *testing.T) {
	// The prompt block explains what a skill is, claims no preinstalled default
	// (init seeds no repository), states the record-then-install effect, the
	// generic removal path (edit skillRepos AND pi uninstall — the entrypoint
	// only installs), and carries the trust caveat — all before the user
	// chooses. The copy stays progressive-disclosure consistent.
	stubInitFlow(t)

	_, workdir := newWorkspace(t)
	deps := skillRepoFlowDeps(t, workdir, []bool{false}, []string{"owner/repo"})
	output := testutil.CaptureStderr(t, func() {
		if err := runInit(context.Background(), deps); err != nil {
			t.Fatalf("flow: %v", err)
		}
	})
	// Header contract preserved (one consistent term: Custom Skills) and the
	// definition wording; the remaining assertions guard the removal path and
	// the trust caveat, and that no default repo is advertised any more.
	if !strings.Contains(output, "Custom Skills") {
		t.Error("header 'Custom Skills' must be printed")
	}
	if !strings.Contains(output, "Skills (reusable instruction sets for pi)") {
		t.Error("prompt must explain what a skill is before the choice")
	}
	if strings.Contains(output, "Installed by default") {
		t.Errorf("prompt must not claim an installed default, got: %q", output)
	}
	if !strings.Contains(output, "deleting it from skillRepos") || !strings.Contains(output, "pi uninstall") {
		t.Errorf("removal path must mention deleting from skillRepos AND `pi uninstall`, got: %q", output)
	}
	if !strings.Contains(output, "cheasee-settings.json skillRepos") || !strings.Contains(output, "cheasee-pi start") {
		t.Error("prompt must state the effect: recorded in skillRepos, installed on next cheasee-pi start")
	}
	if !strings.Contains(output, "Review a repo's content") {
		t.Error("prompt must carry the trust caveat (skills can include runnable code)")
	}
	if strings.Contains(output, "loads into every session") {
		t.Error("copy must not claim skills load into every session (progressive disclosure)")
	}
}
