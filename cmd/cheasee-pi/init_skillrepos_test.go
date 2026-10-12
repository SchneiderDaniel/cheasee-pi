package main

import (
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
		{"local dot", "./repo", "local paths"},
		{"local abs", "/abs/x", "local paths"},
		{"local parent", "../repo", "local paths"},
		{"npm source", "npm:@earendil-works/pi-coding-agent", "npm:"},
		{"bare scp no prefix", "git@github.com:user/repo", "git:"},
		{"credential bearer", "https://token@github.com/user/repo", "embedded credentials"},
		{"garbage", "not a repo", "invalid skill repo"},
		{"gitlab https refused", "https://gitlab.com/a/b", "invalid skill repo"},
		{"scheme URL no authority", "https:///owner/repo", "invalid skill repo"},
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
