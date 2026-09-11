package main

import (
	"encoding/json"
	"fmt"
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
	// The link semantics live in link_owned: re-link only under a [ -L guard,
	// via ln -sfn; re_point delegates each repo entry to it.
	if !strings.Contains(content, "[ -L \"$link\" ]") {
		t.Error("link_owned must re-link only under a [ -L \"$link\" ] guard")
	}
	if !strings.Contains(content, "ln -sfn \"$target\" \"$link\"") {
		t.Error("link_owned must re-point via ln -sfn against the target")
	}
	if !strings.Contains(content, "link_owned \"$agent_dir/$name\" \"$d\"") {
		t.Error("re_point must delegate each repo entry to link_owned")
	}
}

func TestEntrypoint_NoOpOnSameTarget(t *testing.T) {
	content := readEntrypoint(t)
	// link_owned's readlink idempotency: skip when the link already points at
	// the target (no churn across restarts).
	if !strings.Contains(content, "readlink \"$link\"") {
		t.Error("link_owned must readlink the existing link to detect no-op")
	}
	if !strings.Contains(content, "= \"$target\"") {
		t.Error("link_owned must skip when readlink already equals the target")
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
	// The single-file contract lives in link_owned (shared primitives) plus a
	// thin re_point_file wrapper that keeps the missing-repo-file guard.
	for _, want := range []string{
		"[ -L \"$link\" ]",                       // re-link only under a [ -L ] guard
		"readlink \"$link\"",                     // readlink no-op detection
		"= \"$target\"",                          // skip when already at the target
		"ln -sfn \"$target\" \"$link\"",          // re-point with ln -sfn
		"chown -h agentuser:agentuser \"$link\"", // chown -h the link
		"[ -e \"$repo_file\" ] || return 0",      // missing repo file → baked link stays
		"link_owned \"$agent_file\" \"$repo_file\"",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("re_point_file must honor the re_point contract (%q)", want)
		}
	}
}

func TestEntrypoint_RepointFileConflictRefusal(t *testing.T) {
	content := readEntrypoint(t)
	// A real file at the link name must be left untouched — link_owned may
	// only create a link when nothing occupies the link name (elif branch).
	if !strings.Contains(content, "elif [ ! -e \"$link\" ]") {
		t.Error("link_owned must create missing links only when nothing occupies the link name")
	}
	if strings.Contains(content, "rm -rf") {
		t.Error("link_owned must not rm -rf anything (AC: no container FS mutation)")
	}
}

// ──────────────────────────────────────────────
// Phase 2c: extracted link_owned helper + venv loop (#1609)
// ──────────────────────────────────────────────

func TestEntrypoint_LinkOwnedDefinedAndUsed(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "link_owned() {") {
		t.Error("entrypoint must define link_owned()")
	}
	// All three call sites must route through the helper (re_point delegation,
	// the re_point_file wrapper, the custom/ block).
	for _, want := range []string{
		"link_owned \"$agent_dir/$name\" \"$d\"",
		"link_owned \"$agent_file\" \"$repo_file\"",
		"link_owned /home/agentuser/.pi/agent/custom /workspaces/main/custom",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("link_owned must be used by all three call sites (%q)", want)
		}
	}
}

func TestEntrypoint_ChownNewLinks(t *testing.T) {
	content := readEntrypoint(t)
	// The repeated `chown -h … || true` swallow concentrates in link_owned.
	if !strings.Contains(content, "chown -h agentuser:agentuser \"$link\"") {
		t.Error("link_owned must chown -h each re-pointed link to agentuser")
	}
}

// extractFunc pulls the named function definition out of entrypoint.sh (from
// `name() {` to the closing brace at column 0) so behavioral checks execute the
// production function, never a test-side copy (audit: extract-or-execute).
func extractFunc(t *testing.T, name string) string {
	t.Helper()
	content := readEntrypoint(t)
	start := strings.Index(content, name+"() {")
	if start < 0 {
		t.Fatalf("entrypoint must define %s()", name)
	}
	rel := content[start:]
	// Body lines are indented; the definition closes with a bare } at column 0.
	end := strings.Index(rel, "\n}\n")
	if end < 0 {
		t.Fatalf("%s() definition must close with } at column 0", name)
	}
	return rel[:end+len("\n}\n")]
}

// extractLinkOwned pulls the actual link_owned() function definition out of
// entrypoint.sh (from `link_owned() {` to the closing brace at column 0) so
// behavioral checks execute the production function, never a test-side copy
// (audit: extract-or-execute).
func extractLinkOwned(t *testing.T) string {
	return extractFunc(t, "link_owned")
}

func TestEntrypoint_LinkOwnedBehavior(t *testing.T) {
	// link_owned's low-level primitives in real bash, running the function text
	// EXTRACTED from entrypoint.sh: create-when-absent, re-point-when-
	// target-differs, no-op when readlink already equals the target, and a real
	// file at the link name left untouched (conflict refusal — never over a
	// real file/dir, never rm -rf). chown -h in the extracted body fails
	// harmlessly here (2>/dev/null || true swallow is part of the production
	// function).
	body := `
root="$1"; t1="$root/t1"; t2="$root/t2"; l="$root/link"
mkdir -p "$t1" "$t2"
link_owned "$l" "$t1"                                   # create when absent
[ -L "$l" ] && [ "$(readlink "$l")" = "$t1" ]
link_owned "$l" "$t2"                                   # re-point when differs
[ "$(readlink "$l")" = "$t2" ]
link_owned "$l" "$t2"                                   # no-op when same target
[ "$(readlink "$l")" = "$t2" ]
echo "real file" > "$root/real"
link_owned "$root/real" "$t1"                           # conflict refusal
[ ! -L "$root/real" ] && [ "$(cat "$root/real")" = "real file" ]
echo OK
`
	script := "set -e\n" + extractLinkOwned(t) + body
	root := t.TempDir()
	out, err := exec.Command("bash", "-c", script, "bash", root).CombinedOutput()
	if err != nil {
		t.Fatalf("link_owned behavioral check failed: %v (%s)", err, out)
	}
	if got := strings.TrimSpace(string(out)); got != "OK" {
		t.Errorf("link_owned behavioral check = %q, want OK", got)
	}
}

func TestEntrypoint_VenvCopyLoop(t *testing.T) {
	content := readEntrypoint(t)
	// The two identical venv copy blocks fold into one loop; both guards,
	// mkdir, and cp -a survive per iteration.
	for _, want := range []string{
		"for v in web-search-venv scrapling-venv",
		"[ -d \"/opt/venvs/$v\" ]",
		"[ ! -d \"/workspaces/main/.pi/$v\" ]",
		"mkdir -p /workspaces/main/.pi",
		"cp -a \"/opt/venvs/$v\" \"/workspaces/main/.pi/$v\"",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("venv pre-install loop must contain %q", want)
		}
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

// ──────────────────────────────────────────────
// Phase 6: CHEASEEPI_CPUS command injection hardening (#1671)
// ──────────────────────────────────────────────

// runBashScript feeds a bash program (function text + body) to real bash,
// honoring the audit extract-and-execute convention: the production function
// text is pulled verbatim from entrypoint.sh, never re-typed in the test.
func runBashScript(t *testing.T, script string) (string, error) {
	t.Helper()
	out, err := exec.Command("bash", "-c", script).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// funcScript returns a set -e bash program that defines the extracted
// production function and then runs body.
func funcScript(t *testing.T, name string, body string) string {
	t.Helper()
	return "set -e\n" + extractFunc(t, name) + body
}

// assertOK asserts the extract-and-execute run succeeded and printed OK.
func assertOK(t *testing.T, out string, err error, what string) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s failed: %v (%s)", what, err, out)
	}
	if !strings.Contains(out, "OK") {
		t.Errorf("%s = %q, want OK", what, out)
	}
}

// shq single-quotes s so hostile values reach the extracted function
// literally — the test's own shell must never expand them.
func shq(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// ── Phase 6a: structural hardening ────────────────────────────────

func TestEntrypoint_NoAwkInterpolation(t *testing.T) {
	content := readEntrypoint(t)
	// The vulnerable pattern: env vars interpolated into a double-quoted awk
	// program string (shell/awk metacharacters execute as root).
	for _, bad := range []string{`awk "BEGIN`, `$CHEASEEPI_CPUS * `} {
		if strings.Contains(content, bad) {
			t.Errorf("entrypoint must not interpolate env vars into an awk program string (%q)", bad)
		}
	}
	if !strings.Contains(content, "awk -v cpus=") {
		t.Error("entrypoint must pass CHEASEEPI_CPUS to awk via -v cpus= (never as program text)")
	}
}

func TestEntrypoint_AwkProgramConstant(t *testing.T) {
	content := readEntrypoint(t)
	// The awk program must be a single-quoted constant with no env-var
	// references — -v assignments are the only channel for values.
	if !strings.Contains(content, `'BEGIN {printf "%d", cpus * period}'`) {
		t.Errorf("awk program must be the single-quoted constant 'BEGIN {printf \"%%d\", cpus * period}'")
	}
	if !strings.Contains(content, `-v period="$PERIOD"`) {
		t.Error("awk invocation must pass the period via -v as well")
	}
	if !strings.Contains(content, `printf "%d"`) {
		t.Error("awk printf format must be quoted (mawk rejects the unquoted form for all inputs)")
	}
}

func TestEntrypoint_CpusValidationRegex(t *testing.T) {
	content := readEntrypoint(t)
	const re = `^[0-9]+(\.[0-9]+)?$`
	if !strings.Contains(content, re) {
		t.Errorf("entrypoint must validate CHEASEEPI_CPUS with anchored regex %s (ERE, unquoted, full match)", re)
	}
	reIdx := strings.Index(content, re)
	awkIdx := strings.Index(content, "awk -v cpus=")
	if reIdx > awkIdx {
		t.Error("validation regex must be evaluated before any awk invocation")
	}
}

func TestEntrypoint_CpusInvalidWarningNonFatal(t *testing.T) {
	content := readEntrypoint(t)
	// Invalid-input warning must name CHEASEEPI_CPUS (distinguishable from the
	// cgroup-write-failure warning) and must be non-fatal: early-return, no exit.
	if !strings.Contains(content, "Warning: CHEASEEPI_CPUS=") {
		t.Error("invalid CHEASEEPI_CPUS must emit a warning that names the variable")
	}
	body := extractFunc(t, "apply_cpu_limit")
	if strings.Contains(body, "exit") {
		t.Error("apply_cpu_limit must never exit (invalid CHEASEEPI_CPUS is non-fatal)")
	}
	// After the warning the very next statement must be the non-fatal return 0
	// (the other return 0 — the empty-value skip — legitimately precedes it).
	warnIdx := strings.Index(body, "Warning: CHEASEEPI_CPUS=")
	if warnIdx < 0 {
		t.Error("invalid CHEASEEPI_CPUS must emit a warning that names the variable")
		return
	}
	afterWarn := body[warnIdx:]
	retIdx := strings.Index(afterWarn, "return 0")
	fiIdx := strings.Index(afterWarn, "\n    fi")
	if retIdx < 0 || retIdx > fiIdx {
		t.Error("the CHEASEEPI_CPUS warning must be followed by a non-fatal return 0")
	}
}

func TestEntrypoint_CpuLimitOrderingAndPeriod(t *testing.T) {
	content := readEntrypoint(t)
	defIdx := strings.Index(content, "apply_cpu_limit() {")
	invIdx := strings.Index(content, "\napply_cpu_limit\n")
	execIdx := strings.Index(content, `exec gosu agentuser "$@"`)
	if defIdx < 0 || invIdx < 0 || execIdx < 0 {
		t.Fatal("expected apply_cpu_limit definition/invocation and final exec gosu agentuser")
	}
	if defIdx > execIdx || invIdx > execIdx {
		t.Error("the CPU limit block must run before the final exec gosu agentuser")
	}
	if !strings.Contains(content, "PERIOD=100000") {
		t.Error("PERIOD=100000 must be retained")
	}
}

func TestEntrypoint_RemapUidGidDefinedWithNumericGuard(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "remap_uid_gid() {") {
		t.Error("entrypoint must define remap_uid_gid()")
	}
	if !strings.Contains(content, "\nremap_uid_gid\n") {
		t.Error("entrypoint must invoke remap_uid_gid()")
	}
	// Numeric guard for both vars, warning names the variable, non-fatal.
	if !strings.Contains(content, `[[ "$HOST_UID" =~ ^[0-9]+$ ]]`) {
		t.Error("remap_uid_gid must guard HOST_UID with an anchored numeric regex")
	}
	if !strings.Contains(content, `[[ "$HOST_GID" =~ ^[0-9]+$ ]]`) {
		t.Error("remap_uid_gid must guard HOST_GID with an anchored numeric regex")
	}
	if !strings.Contains(content, "Warning: HOST_UID=") || !strings.Contains(content, "Warning: HOST_GID=") {
		t.Error("non-numeric HOST_UID/HOST_GID must warn naming the variable")
	}
	// Workspace auto-detect block retained unchanged, ordered before the remap.
	for _, want := range []string{"stat -c '%u' /workspaces/main", "Auto-detected HOST_UID=", "Auto-detected HOST_GID="} {
		if !strings.Contains(content, want) {
			t.Errorf("workspace auto-detect block must be retained (%q)", want)
		}
	}
}

// ── Phase 6b: apply_cpu_limit() entity behavior ───────────────────

func TestEntrypoint_ApplyCpuLimit_ValidValues(t *testing.T) {
	// Characterization of the corrected intended behavior: numeric values map
	// cpus*100000 into the quota, written as "<quota> 100000" to cpu.max.
	cases := map[string]string{
		"4.0":  "400000 100000",
		"2":    "200000 100000",
		"1":    "100000 100000",
		"0.25": "25000 100000",
		"0.1":  "10000 100000",
		"16.0": "1600000 100000",
	}
	for value, want := range cases {
		t.Run(value, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(dir, "cpu.max")
			body := fmt.Sprintf(`
cd %s
CHEASEEPI_CPUS=%s CGROUP_CPU_MAX=%s apply_cpu_limit
[ "$(cat %s)" = %s ] || { echo "unexpected content: $(cat %s)"; exit 1; }
echo OK
`, shq(dir), shq(value), shq(target), shq(target), shq(want), shq(target))
			out, err := runBashScript(t, funcScript(t, "apply_cpu_limit", body))
			assertOK(t, out, err, fmt.Sprintf("apply_cpu_limit(%q)", value))
		})
	}
}

func TestEntrypoint_ApplyCpuLimit_ZeroNoWrite(t *testing.T) {
	for _, value := range []string{"0", "0.0"} {
		t.Run(value, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(dir, "cpu.max")
			body := fmt.Sprintf(`
cd %s
CHEASEEPI_CPUS=%s CGROUP_CPU_MAX=%s apply_cpu_limit
[ ! -e %s ] || { echo "cpu.max written"; exit 1; }
echo OK
`, shq(dir), shq(value), shq(target), shq(target))
			out, err := runBashScript(t, funcScript(t, "apply_cpu_limit", body))
			assertOK(t, out, err, fmt.Sprintf("apply_cpu_limit(%q)", value))
		})
	}
}

func TestEntrypoint_ApplyCpuLimit_EmptySilentSkip(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "cpu.max")
	body := fmt.Sprintf(`
cd %s
unset CHEASEEPI_CPUS
out1=$(CGROUP_CPU_MAX=%s apply_cpu_limit)
out2=$(CHEASEEPI_CPUS='' CGROUP_CPU_MAX=%s apply_cpu_limit)
[ -z "$out1" ] || { echo "unset produced output: $out1"; exit 1; }
[ -z "$out2" ] || { echo "empty produced output: $out2"; exit 1; }
[ ! -e %s ] || { echo "cpu.max written"; exit 1; }
echo OK
`, shq(dir), shq(target), shq(target), shq(target))
	out, err := runBashScript(t, funcScript(t, "apply_cpu_limit", body))
	assertOK(t, out, err, "empty/unset apply_cpu_limit")
}

func TestEntrypoint_ApplyCpuLimit_HostileRejected(t *testing.T) {
	// Every hostile value must warn (naming CHEASEEPI_CPUS), write nothing,
	// create no file, and return 0 — never reach awk, never execute.
	hostile := []string{
		`0.5; system("touch $tmp")`,
		"0.5; touch $tmp; ",
		"$(touch $tmp)",
		"4; touch $tmp",
		"abc",
		"4.0.1",
		"-2",
		"1e6",
		".5",
		"5.",
		"4,0",
		" 4.0",
		"4.0 ",
	}
	for _, value := range hostile {
		t.Run(value, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(dir, "cpu.max")
			body := fmt.Sprintf(`
cd %s
tmp="$PWD/injected"
out=$(CHEASEEPI_CPUS=%s CGROUP_CPU_MAX=%s apply_cpu_limit)
case "$out" in
  *"Warning: CHEASEEPI_CPUS="*) ;;
  *) echo "no CHEASEEPI_CPUS warning: $out"; exit 1 ;;
esac
[ ! -e "$tmp" ] || { echo "injection executed"; exit 1; }
[ ! -e %s ] || { echo "cpu.max written"; exit 1; }
echo OK
`, shq(dir), shq(value), shq(target), shq(target))
			out, err := runBashScript(t, funcScript(t, "apply_cpu_limit", body))
			assertOK(t, out, err, fmt.Sprintf("apply_cpu_limit(%q)", value))
		})
	}
}

func TestEntrypoint_ApplyCpuLimit_AwkFailureWarns(t *testing.T) {
	// awk failing (never hostile input — regex-validated above, but e.g. float
	// overflow on a huge valid number) must warn, write nothing, and return 0 —
	// NOT silently return success with cpu.max unchanged (audit: visible error
	// handling). Stub awk via PATH to force the failure deterministically.
	dir := t.TempDir()
	binDir := t.TempDir()
	stubBin(t, binDir, "awk", filepath.Join(t.TempDir(), "marker"), "exit 1")
	target := filepath.Join(dir, "cpu.max")
	body := fmt.Sprintf(`
cd %s
out=$(PATH=%s CHEASEEPI_CPUS='4.0' CGROUP_CPU_MAX=%s apply_cpu_limit)
case "$out" in
  *"Warning: could not compute CPU quota"*) ;;
  *) echo "no CPU-quota warning: $out"; exit 1 ;;
esac
[ ! -e %s ] || { echo "cpu.max written"; exit 1; }
echo OK
`, shq(dir), shq(binDir+":"+os.Getenv("PATH")), shq(target), shq(target))
	out, err := runBashScript(t, funcScript(t, "apply_cpu_limit", body))
	assertOK(t, out, err, "apply_cpu_limit awk-failure path")
}

func TestEntrypoint_ApplyCpuLimit_WriteFailureWarns(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "no-such-dir", "cpu.max")
	body := fmt.Sprintf(`
cd %s
out=$(CHEASEEPI_CPUS='4.0' CGROUP_CPU_MAX=%s apply_cpu_limit)
case "$out" in
  *"could not write CPU limit"*) ;;
  *) echo "no cgroup warning: $out"; exit 1 ;;
esac
echo OK
`, shq(dir), shq(target))
	out, err := runBashScript(t, funcScript(t, "apply_cpu_limit", body))
	assertOK(t, out, err, "apply_cpu_limit write-failure path")
}

func TestEntrypoint_ApplyCpuLimit_Idempotent(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "cpu.max")
	body := fmt.Sprintf(`
cd %s
CHEASEEPI_CPUS='4.0' CGROUP_CPU_MAX=%s apply_cpu_limit
CHEASEEPI_CPUS='4.0' CGROUP_CPU_MAX=%s apply_cpu_limit
[ "$(cat %s)" = '400000 100000' ] || { echo "unexpected: $(cat %s)"; exit 1; }
echo OK
`, shq(dir), shq(target), shq(target), shq(target), shq(target))
	out, err := runBashScript(t, funcScript(t, "apply_cpu_limit", body))
	assertOK(t, out, err, "apply_cpu_limit re-run")
}

// ── Phase 6c: remap_uid_gid() numeric guard ───────────────────────

// stubBin writes an executable sh stub that appends "<name> $@" to marker
// (plus extra body), so behavioral checks observe remap_uid_gid's external
// calls without root or real usermod/groupmod.
func stubBin(t *testing.T, dir, name, marker, extra string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	content := "#!/bin/sh\necho \"" + name + " $@\" >> '" + marker + "'\n" + extra + "\nexit 0\n"
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write stub %s: %v", name, err)
	}
	return path
}

// remapStubs returns the temp bin dir (prepended to PATH) and the marker file
// path with usermod/groupmod/id stubbed in; id reports 1000 for both -u/-g so
// numeric remap targets are always "different" and proceed.
func remapStubs(t *testing.T) (binDir, marker string) {
	t.Helper()
	binDir = t.TempDir()
	marker = filepath.Join(t.TempDir(), "marker")
	stubBin(t, binDir, "usermod", marker, "")
	stubBin(t, binDir, "groupmod", marker, "")
	idExtra := `case "$1" in
  -u) echo 1000 ;;
  -g) echo 1000 ;;
esac`
	stubBin(t, binDir, "id", marker, idExtra)
	return binDir, marker
}

func TestEntrypoint_RemapUidGid_NonNumericSkipped(t *testing.T) {
	// Both HOST_UID and HOST_GID share the same contract: non-numeric value →
	// warning naming the variable, no usermod/groupmod invocation, no
	// injection, return 0 (would abort under set -e today).
	binDir, marker := remapStubs(t)
	cases := []struct{ varName, warning string }{
		{"HOST_UID", "Warning: HOST_UID="},
		{"HOST_GID", "Warning: HOST_GID="},
	}
	hostile := []string{"abc", "-1", "4.5", "1000; touch $tmp; "}
	for _, c := range cases {
		for _, value := range hostile {
			t.Run(c.varName+"/"+value, func(t *testing.T) {
				dir := t.TempDir()
				body := fmt.Sprintf(`
cd %s
unset HOST_UID HOST_GID
tmp="$PWD/injected"
out=$(PATH=%s %s=%s remap_uid_gid)
case "$out" in
  *"%s"*) ;;
  *) echo "no %s warning: $out"; exit 1 ;;
esac
[ ! -e %s ] || { echo "usermod/groupmod invoked"; exit 1; }
[ ! -e "$tmp" ] || { echo "injection executed"; exit 1; }
echo OK
`, shq(dir), shq(binDir+":"+os.Getenv("PATH")), c.varName, shq(value), c.warning, c.varName, shq(marker))
				out, err := runBashScript(t, funcScript(t, "remap_uid_gid", body))
				assertOK(t, out, err, fmt.Sprintf("remap_uid_gid(%s=%q)", c.varName, value))
			})
		}
	}
}

func TestEntrypoint_RemapUidGid_NumericProceeds(t *testing.T) {
	binDir, marker := remapStubs(t)
	body := fmt.Sprintf(`
cd %s
unset HOST_UID HOST_GID
PATH=%s HOST_UID=1234 HOST_GID=1234 remap_uid_gid
grep -q -- "-u 1234" %s || { echo "usermod -u 1234 not recorded"; exit 1; }
grep -q -- "-g 1234" %s || { echo "usermod -g 1234 not recorded"; exit 1; }
grep -q "groupmod -g 1234" %s || { echo "groupmod -g 1234 not recorded"; exit 1; }
echo OK
`, shq(t.TempDir()), shq(binDir+":"+os.Getenv("PATH")), shq(marker), shq(marker), shq(marker))
	out, err := runBashScript(t, funcScript(t, "remap_uid_gid", body))
	assertOK(t, out, err, "remap_uid_gid(1234/1234)")
}
