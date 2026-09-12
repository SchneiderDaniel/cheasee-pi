package main

import (
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 5: custom skill repo install (pi git packages)
// ──────────────────────────────────────────────

func TestEntrypoint_DefinesInstallSkillRepos(t *testing.T) {
	content := readEntrypoint(t)
	if strings.Count(content, "install_skill_repos") < 2 {
		t.Error("entrypoint must define AND invoke install_skill_repos")
	}
	if !strings.Contains(content, "install_skill_repos() {") {
		t.Error("entrypoint must define install_skill_repos()")
	}
}

func TestEntrypoint_InstallSkillReposReadsSettings(t *testing.T) {
	content := readEntrypoint(t)
	for _, want := range []string{
		"/workspaces/main/cheasee-settings.json",
		"jq -r '.skillRepos // empty | .[]'",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("install_skill_repos must read skillRepos from cheasee-settings.json via jq (%q)", want)
		}
	}
}

func TestEntrypoint_InstallSkillReposPiInstall(t *testing.T) {
	content := readEntrypoint(t)
	for _, want := range []string{
		"pi install -l -a",      // project-local + one-run trust override
		"gosu agentuser",        // runs as the remapped non-root user
		"GIT_TERMINAL_PROMPT=0", // non-GitHub SSH-only repos must not hang
	} {
		if !strings.Contains(content, want) {
			t.Errorf("install_skill_repos must use %q", want)
		}
	}
}

func TestEntrypoint_InstallSkillReposPerRepoFailureTolerant(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "Warning: skill repo install failed") {
		t.Error("per-repo install failure must warn, not abort (set -e tolerance)")
	}
}

func TestEntrypoint_InstallSkillReposOfflineWarning(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "PI_OFFLINE") {
		t.Error("install_skill_repos must check PI_OFFLINE (pi silently skips missing packages offline)")
	}
}

func TestEntrypoint_InstallSkillReposOrdering(t *testing.T) {
	content := readEntrypoint(t)
	gitCfg := strings.Index(content, "credential.helper")
	install := strings.Index(content, "install_skill_repos() {")
	ready := strings.Index(content, "touch /tmp/.cheasee-pi-ready")
	if gitCfg < 0 || install < 0 || ready < 0 {
		t.Fatalf("expected git-config block, install_skill_repos, and readiness marker, got indices %d/%d/%d", gitCfg, install, ready)
	}
	if !(gitCfg < install && install < ready) {
		t.Errorf("install_skill_repos must run after git config and before the readiness marker (indices %d/%d/%d)", gitCfg, install, ready)
	}
}

func TestEntrypoint_InstallSkillReposNeverWritesPISettings(t *testing.T) {
	content := readEntrypoint(t)
	if strings.Contains(content, ".pi/settings.json") {
		t.Error("entrypoint must never reference .pi/settings.json (pi owns the packages array — scaffold contract)")
	}
}

func TestEntrypoint_InstallSkillReposMissingSettingsNoop(t *testing.T) {
	// Raw `docker compose up` path (no cheasee-settings.json or empty
	// skillRepos) must no-op — the loop guards on the file and the array.
	content := readEntrypoint(t)
	if !strings.Contains(content, "[ -f \"$settings\" ] || return 0") {
		t.Error("missing cheasee-settings.json must no-op")
	}
	if !strings.Contains(content, "[ -n \"$specs\" ] || return 0") {
		t.Error("absent/empty skillRepos must no-op")
	}
}

// ──────────────────────────────────────────────
// Phase 5b: container gh credential sync (single source of truth)
// ──────────────────────────────────────────────

func TestEntrypoint_GhTokenSyncReadsAuthJSON(t *testing.T) {
	content := readEntrypoint(t)
	for _, want := range []string{
		"/home/agentuser/.config/cheasee-pi/auth.json",
		"jq -r '.github_token // empty'",
		"gh auth token",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("gh token sync must read auth.json and compare against gh's current token (%q)", want)
		}
	}
}

func TestEntrypoint_GhTokenSyncImportsOnMismatch(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, `[ "$token" != "$current" ]`) {
		t.Error("gh token sync must import auth.json's token when gh's current token differs (not only when gh has no token)")
	}
	if !strings.Contains(content, "gh auth login --with-token") {
		t.Error("gh token sync must import via gh auth login --with-token")
	}
	if strings.Contains(content, "! gosu agentuser gh auth status") {
		t.Error("gh token sync must not gate on gh auth status (a bind-mounted stale token would always pass it)")
	}
}

func TestEntrypoint_GhTokenSyncNoopWhenAuthMissing(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, `[ -n "$token" ]`) {
		t.Error("gh token sync must no-op when auth.json has no github_token")
	}
}
