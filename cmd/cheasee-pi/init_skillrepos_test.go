package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestCanonicalSkillRepo(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"shorthand", "owner/repo", "https://github.com/owner/repo"},
		{"https verbatim", "https://github.com/user/repo", "https://github.com/user/repo"},
		{"https with .git verbatim", "https://github.com/user/repo.git", "https://github.com/user/repo.git"},
		{"https trailing slash verbatim", "https://github.com/user/repo/", "https://github.com/user/repo/"},
		{"git host/path passthrough", "git:github.com/user/repo", "git:github.com/user/repo"},
		{"git scp passthrough", "git:git@github.com:user/repo", "git:git@github.com:user/repo"},
		{"git ref preserved", "git:github.com/user/repo@v1.2.3", "git:github.com/user/repo@v1.2.3"},
		{"ssh passthrough", "ssh://git@github.com/user/repo", "ssh://git@github.com/user/repo"},
		{"shorthand trimmed", "  owner/repo  ", "https://github.com/owner/repo"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := canonicalSkillRepo(tc.in)
			if err != nil {
				t.Fatalf("canonicalSkillRepo(%q): %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("canonicalSkillRepo(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestCanonicalSkillRepo_Rejects(t *testing.T) {
	rejects := []struct {
		name string
		in   string
		want string // substring the error must contain
	}{
		{"empty", "", "empty skill repo spec"},
		{"whitespace", "   ", "empty skill repo spec"},
		{"local dot", "./x", "local paths"},
		{"local abs", "/abs/x", "local paths"},
		{"local parent", "../x", "local paths"},
		{"npm source", "npm:@earendil-works/pi-coding-agent", "npm:"},
		{"bare scp no prefix", "git@github.com:user/repo", "git:"},
		{"credential bearer", "https://token@github.com/user/repo", "embedded credentials"},
		{"garbage", "not a repo", "invalid skill repo"},
		{"git prefix without path", "git:onlyhost", "git:"},
	}
	for _, tc := range rejects {
		t.Run(tc.name, func(t *testing.T) {
			_, err := canonicalSkillRepo(tc.in)
			if err == nil {
				t.Fatalf("canonicalSkillRepo(%q) must error", tc.in)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error should mention %q, got: %v", tc.want, err)
			}
		})
	}
}

func TestCanonicalSkillRepo_RedactsCredentials(t *testing.T) {
	_, err := canonicalSkillRepo("https://s3cr3t@github.com/user/repo")
	if err == nil {
		t.Fatal("credential-bearing spec must error")
	}
	if strings.Contains(err.Error(), "s3cr3t") {
		t.Errorf("error must redact the embedded credential, got: %v", err)
	}
}

func TestRecordSkillRepos(t *testing.T) {
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider": "opencode-go"}`)

	if err := recordSkillRepos(workdir, []string{"https://github.com/a/b", "git:github.com/c/d"}); err != nil {
		t.Fatalf("first record: %v", err)
	}
	s, err := LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.SkillRepos) != 2 || s.SkillRepos[0] != "https://github.com/a/b" || s.SkillRepos[1] != "git:github.com/c/d" {
		t.Fatalf("unexpected skillRepos after first record: %v", s.SkillRepos)
	}

	// Additive merge: existing entries preserved, duplicate not re-added.
	if err := recordSkillRepos(workdir, []string{"git:github.com/c/d", "https://github.com/e/f"}); err != nil {
		t.Fatalf("second record: %v", err)
	}
	second, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	s, err = LoadCheaseeSettings(workdir)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.SkillRepos) != 3 || s.SkillRepos[2] != "https://github.com/e/f" {
		t.Fatalf("additive merge failed: %v", s.SkillRepos)
	}

	// All-duplicate input: byte-stable (no rewrite).
	if err := recordSkillRepos(workdir, []string{"https://github.com/e/f"}); err != nil {
		t.Fatalf("third record: %v", err)
	}
	third, err := os.ReadFile(filepath.Join(workdir, "cheasee-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(second) != string(third) {
		t.Errorf("all-duplicate record must be byte-stable:\nsecond: %s\nthird: %s", second, third)
	}
}

func TestRecordSkillRepos_EmptyInputNoOp(t *testing.T) {
	workdir := t.TempDir() // no settings file at all
	if err := recordSkillRepos(workdir, nil); err != nil {
		t.Fatalf("empty input must be a no-op: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workdir, "cheasee-settings.json")); !os.IsNotExist(err) {
		t.Error("empty input must not create/write cheasee-settings.json")
	}
}

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
	want := []string{"https://github.com/owner/repo", "git:github.com/x/y"}
	if len(s.SkillRepos) != 2 || s.SkillRepos[0] != want[0] || s.SkillRepos[1] != want[1] {
		t.Errorf("skillRepos = %v, want %v", s.SkillRepos, want)
	}
}

func TestRunInitSkillRepos_EmptyInputStopsLoop(t *testing.T) {
	// Empty/whitespace InputFn input is the silent done signal.
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
		t.Errorf("empty input must record nothing, got %v", s.SkillRepos)
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

func TestRunInitSkillRepos_NoInputNoFlagsNoop(t *testing.T) {
	// --no-input without --skill-repo: phase skipped entirely, no skillRepos
	// key emitted.
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
		t.Errorf("no-input without flags must record nothing, got %v", s.SkillRepos)
	}
	raw := testutil.ReadCheaseeSettingsRaw(t, workdir)
	if _, ok := raw["skillRepos"]; ok {
		t.Error("no-input without flags must not emit a skillRepos key")
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
		t.Errorf("skillRepos = %v, want %v (flag+prompt dupes collapsed)", s.SkillRepos, want)
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
