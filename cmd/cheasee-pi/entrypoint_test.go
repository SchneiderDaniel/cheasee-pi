package main

import (
	"encoding/json"
	"os"
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
		"\"rtk\"",          // extensions: tracked local extension kept
		"\".pi/skills\"",   // skills: tracked local dir kept
		"\"cheasee-pi\"",   // theme unchanged
		"ponytail",         // packages unchanged
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
