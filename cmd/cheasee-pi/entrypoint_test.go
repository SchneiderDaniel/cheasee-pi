package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// entrypointPath is the embedded container entrypoint.
func entrypointPath() string {
	return filepath.Join("embedded", "docker", "entrypoint.sh")
}

// committedSettingsPath is the repo's committed dogfooding settings
// (repo root, sibling of cmd/).
func committedSettingsPath() string {
	return filepath.Join("..", "..", ".pi", "settings.json")
}

// scaffoldSettingsPath is the consumer-repo settings template embedded in the
// CLI cache dir.
func scaffoldSettingsPath() string {
	return filepath.Join("embedded", "pi", "settings.json")
}

func readEntrypoint(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(entrypointPath())
	if err != nil {
		t.Fatalf("read embedded entrypoint.sh: %v", err)
	}
	return string(data)
}

func readCommittedSettings(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(committedSettingsPath())
	if err != nil {
		t.Fatalf("read committed .pi/settings.json: %v", err)
	}
	return string(data)
}

func readScaffoldSettings(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(scaffoldSettingsPath())
	if err != nil {
		t.Fatalf("read embedded/pi/settings.json: %v", err)
	}
	return string(data)
}

// detectionBody slices the body of is_cheasee_pi_repo() out of the entrypoint
// (from the opening brace to the next closing brace at column 0).
func detectionBody(t *testing.T, content string) string {
	t.Helper()
	const open = "is_cheasee_pi_repo() {"
	i := strings.Index(content, open)
	if i < 0 {
		t.Fatal("is_cheasee_pi_repo() not defined")
	}
	body := content[i+len(open):]
	j := strings.Index(body, "\n}")
	if j < 0 {
		t.Fatal("is_cheasee_pi_repo() body not closed")
	}
	return body[:j]
}

// ──────────────────────────────────────────────
// Phase 1: structural repo detection — is_cheasee_pi_repo()
// ──────────────────────────────────────────────

func TestEntrypoint_DefinesIsCheaseePiRepo(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "is_cheasee_pi_repo() {") {
		t.Error("entrypoint must define is_cheasee_pi_repo()")
	}
	if !strings.Contains(content, "if is_cheasee_pi_repo; then") {
		t.Error("entrypoint must call is_cheasee_pi_repo in a conditional")
	}
}

func TestEntrypoint_DetectionMarkerDir(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "-d /workspaces/main/cmd/cheasee-pi/embedded/docker") {
		t.Error("detection must require -d /workspaces/main/cmd/cheasee-pi/embedded/docker")
	}
}

func TestEntrypoint_DetectionModuleMatch(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "grep -m1 '^module ' /workspaces/main/go.mod") {
		t.Error("detection must parse the module directive via grep -m1 '^module ' /workspaces/main/go.mod")
	}
	if !strings.Contains(content, "github.com/SchneiderDaniel/cheasee-pi") {
		t.Error("detection must match module github.com/SchneiderDaniel/cheasee-pi")
	}
}

func TestEntrypoint_DetectionNotContentBased(t *testing.T) {
	body := detectionBody(t, readEntrypoint(t))
	for _, resource := range []string{".pi/skills", ".pi/extensions", ".pi/prompts", ".pi/themes", "custom"} {
		if strings.Contains(body, resource) {
			t.Errorf("detection must be structural, not content-based — body must not reference %q", resource)
		}
	}
}

func TestEntrypoint_DetectionWorktreeSafe(t *testing.T) {
	body := detectionBody(t, readEntrypoint(t))
	if strings.Contains(body, ".git") {
		t.Error("detection must never inspect /workspaces/main/.git (worktrees use a .git file, not a dir)")
	}
}

func TestDockerfile_MarkerContractDocumented(t *testing.T) {
	content := readDockerfile(t)
	for _, want := range []string{
		"MARKER CONTRACT",
		"cmd/cheasee-pi/embedded/docker",
		"module github.com/SchneiderDaniel/cheasee-pi",
		"forks",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("Dockerfile Layer 6b comment must document the marker contract (%q)", want)
		}
	}
}

// ──────────────────────────────────────────────
// Phase 2: symlink re-pointing — re_point()
// ──────────────────────────────────────────────

func TestEntrypoint_DefinesRepoint(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "re_point() {") {
		t.Error("entrypoint must define re_point()")
	}
	for _, subdir := range []string{"skills", "extensions", "prompts", "themes"} {
		if !strings.Contains(content, "re_point "+subdir+" /workspaces/main/.pi/"+subdir) {
			t.Errorf("re_point must be invoked for the %q resource dir", subdir)
		}
	}
}

func TestEntrypoint_SymlinkOnlyRelink(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "[ -L \"$link\" ]") {
		t.Error("re_point must re-link only under a [ -L \"$link\" ] guard")
	}
	if !strings.Contains(content, "ln -sfn \"$d\" \"$link\"") {
		t.Error("re_point must use ln -sfn against the repo entry")
	}
}

func TestEntrypoint_NoOpOnSameTarget(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "readlink \"$link\"") {
		t.Error("re_point must readlink the existing link to detect no-op")
	}
	if !strings.Contains(content, "= \"$d\"") {
		t.Error("re_point must skip when readlink already equals the repo entry")
	}
}

func TestEntrypoint_MissingTargetGuard(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "[ -e \"$d\" ] || continue") {
		t.Error("re_point must guard each repo entry with [ -e \"$d\" ] (no dangling links)")
	}
}

func TestEntrypoint_NoRmRf(t *testing.T) {
	content := readEntrypoint(t)
	if strings.Contains(content, "rm -rf") {
		t.Error("entrypoint must not rm -rf anything (AC: no container FS mutation)")
	}
}

func TestEntrypoint_ChownNewLinks(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "chown -h agentuser:agentuser \"$link\"") {
		t.Error("re_point must chown -h each re-pointed link to agentuser")
	}
}

func TestEntrypoint_PrivatePiUntouched(t *testing.T) {
	content := readEntrypoint(t)
	if strings.Contains(content, "private-pi") {
		t.Error("entrypoint must never touch private-pi (single source stays at /opt/cheasee-pi, referenced via settings.json)")
	}
}

func TestEntrypoint_CustomDirLink(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "/workspaces/main/custom") {
		t.Error("whole-dir custom/ must be re-pointed at /workspaces/main/custom when present")
	}
	if !strings.Contains(content, "/home/agentuser/.pi/agent/custom") {
		t.Error("custom/ re-point must target /home/agentuser/.pi/agent/custom")
	}
}

func TestEntrypoint_SkipsDotfiles(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "== .* ]]") {
		t.Error("re_point must skip dotfiles (.gitkeep) in repo resource dirs")
	}
}

// ──────────────────────────────────────────────
// Phase 2b: single-file re-pointing — re_point_file()
// ──────────────────────────────────────────────

func TestEntrypoint_DefinesRepointFile(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "re_point_file() {") {
		t.Error("entrypoint must define re_point_file()")
	}
	// Invocation must sit inside the is_cheasee_pi_repo block (definition
	// legitimately precedes it) and carry both paths.
	const invocation = "re_point_file /home/agentuser/.pi/agent/APPEND_SYSTEM.md /workspaces/main/APPEND_SYSTEM.md"
	idx := strings.Index(content, "if is_cheasee_pi_repo; then")
	if idx < 0 {
		t.Fatal("entrypoint must contain the is_cheasee_pi_repo block")
	}
	if !strings.Contains(content[idx:], invocation) {
		t.Error("re_point_file must be invoked inside the is_cheasee_pi_repo block with both paths")
	}
}

func TestEntrypoint_RepointFileContract(t *testing.T) {
	content := readEntrypoint(t)
	for _, want := range []string{
		"[ -L \"$agent_file\" ]",                       // re-link only under a [ -L ] guard
		"readlink \"$agent_file\"",                     // readlink no-op detection
		"= \"$repo_file\"",                             // skip when already at the repo file
		"ln -sfn \"$repo_file\" \"$agent_file\"",       // re-point with ln -sfn
		"chown -h agentuser:agentuser \"$agent_file\"", // chown -h the link
		"[ -e \"$repo_file\" ] || return 0",            // missing repo file → baked link stays
	} {
		if !strings.Contains(content, want) {
			t.Errorf("re_point_file must honor the re_point contract (%q)", want)
		}
	}
}

func TestEntrypoint_RepointFileConflictRefusal(t *testing.T) {
	content := readEntrypoint(t)
	// A real file at the link name must be left untouched — the helper may
	// only create a link when nothing occupies the link name (elif branch).
	if !strings.Contains(content, "elif [ ! -e \"$agent_file\" ]") {
		t.Error("re_point_file must create missing links only when nothing occupies the link name")
	}
	if strings.Contains(content, "rm -rf") {
		t.Error("re_point_file must not rm -rf anything (AC: no container FS mutation)")
	}
}

// ──────────────────────────────────────────────
// Phase 3: committed dogfooding settings rework
// ──────────────────────────────────────────────

func TestCommittedSettings_NoParentPrivatePiRefs(t *testing.T) {
	content := readCommittedSettings(t)
	if strings.Contains(content, "../private-pi") {
		t.Error("committed settings must not reference ../private-pi (untracked — broken for fresh clones)")
	}
}

func TestCommittedSettings_PrivatePathsPointAtOpt(t *testing.T) {
	content := readCommittedSettings(t)
	for _, want := range []string{
		"/opt/cheasee-pi/private-pi/extensions/check-extensions",
		"/opt/cheasee-pi/private-pi/prompts",
		"/opt/cheasee-pi/private-pi/skills",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("committed settings must reference %q", want)
		}
	}
}

func TestCommittedSettings_TrackedPathsRepoLocal(t *testing.T) {
	content := readCommittedSettings(t)
	for _, want := range []string{
		"\"rtk\"",        // extensions: tracked local extension kept
		"\".pi/skills\"", // skills: tracked local dir kept
		"\"cheasee-pi\"", // theme unchanged
		"ponytail",       // packages unchanged
	} {
		if !strings.Contains(content, want) {
			t.Errorf("committed settings must keep %q", want)
		}
	}
}

func TestCommittedSettings_ValidJSON(t *testing.T) {
	content := readCommittedSettings(t)
	var doc map[string]any
	if err := json.Unmarshal([]byte(content), &doc); err != nil {
		t.Fatalf("committed .pi/settings.json must parse as valid JSON: %v", err)
	}
	for _, key := range []string{"extensions", "skills", "prompts", "theme", "packages", "defaultModel"} {
		if _, ok := doc[key]; !ok {
			t.Errorf("committed settings must keep top-level key %q", key)
		}
	}
}

func TestScaffoldSettings_Unchanged(t *testing.T) {
	content := readScaffoldSettings(t)
	// The scaffold governs consumer repos (points at the baked /opt tree) and
	// must not converge with the committed dogfooding settings. private-pi is
	// gitignored and never present in the image, so no private-pi paths.
	for _, want := range []string{
		"/opt/cheasee-pi/.pi/skills",
		"/opt/cheasee-pi/.pi/prompts",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("scaffold settings must still point at %q (consumer repos)", want)
		}
	}
	if strings.Contains(content, "private-pi") {
		t.Error("scaffold settings must not reference private-pi (gitignored, never in the image)")
	}
}

// ──────────────────────────────────────────────
// Phase 4: bare-repo container plumbing (empty-folder init support)
// ──────────────────────────────────────────────

func TestEntrypoint_SafeDirectoryBare(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "safe.directory /workspaces/.bare") {
		t.Error("entrypoint must mark /workspaces/.bare as safe.directory (CVE-2022-24765 dubious-ownership mitigation)")
	}
}

func TestEntrypoint_BareChownParity(t *testing.T) {
	content := readEntrypoint(t)
	for _, want := range []string{
		"stat -c '%u:%g' /workspaces/.bare",
		"chown -R agentuser:agentuser /workspaces/.bare",
		"Fixing /workspaces/.bare ownership",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("entrypoint must chown /workspaces/.bare on ownership mismatch (%q)", want)
		}
	}
	// Existing main-worktree chown retained.
	if !strings.Contains(content, "chown -R agentuser:agentuser /workspaces/main") {
		t.Error("entrypoint must keep the /workspaces/main ownership fix")
	}
}

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

func TestEntrypoint_SyntaxValidBash(t *testing.T) {
	if err := exec.Command("bash", "-n", entrypointPath()).Run(); err != nil {
		t.Errorf("entrypoint.sh must pass bash -n: %v", err)
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
