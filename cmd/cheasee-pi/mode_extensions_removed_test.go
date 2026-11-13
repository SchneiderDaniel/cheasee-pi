package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// modeExtensions are the two response-mode integrations the harness no longer
// ships (#2072). pi's registration interface is directory presence under
// .pi/extensions/, so absence is the removal contract — no flag exists.
var modeExtensions = []string{"caveman", "ponytail"}

// removedPackageFilterDecls are the default-package-policy identifiers that
// existed only for Ponytail and are gone with package_filter.go.
var removedPackageFilterDecls = []string{
	"defaultSkillRepos",
	"defaultPackageFilter",
	"defaultPackageFilters",
	"reconcileDefaultPackageFilters",
	"applyDefaultPackageFilters",
	"encodePackageFilter",
	"packageEntrySource",
	"samePackageSource",
	"settingsExtra",
}

// modeRepoRoot is the repository root from cmd/cheasee-pi (same convention as
// committedSettingsPath).
func modeRepoRoot() string { return filepath.Join("..", "..") }

func TestModeExtensionsRemoved_RuntimeTreesAbsent(t *testing.T) {
	for _, name := range modeExtensions {
		// Lstat, not Stat: a dangling symlink must not pass for an absent tree.
		if _, err := os.Lstat(filepath.Join(modeRepoRoot(), ".pi", "extensions", name)); !os.IsNotExist(err) {
			t.Errorf(".pi/extensions/%s must be absent, lstat err = %v", name, err)
		}
	}
	if _, err := os.Lstat(filepath.Join(modeRepoRoot(), ".pi", "skills", "ponytail")); !os.IsNotExist(err) {
		t.Errorf(".pi/skills/ponytail must be absent, lstat err = %v", err)
	}
}

func TestModeExtensionsRemoved_NoDefaultPackagePolicy(t *testing.T) {
	if _, err := os.Lstat("package_filter.go"); !os.IsNotExist(err) {
		t.Errorf("package_filter.go must be absent, lstat err = %v", err)
	}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob *.go: %v", err)
	}
	removed := make(map[string]bool, len(removedPackageFilterDecls))
	for _, name := range removedPackageFilterDecls {
		removed[name] = true
	}
	for _, file := range files {
		fset := token.NewFileSet()
		parsed, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", file, err)
		}
		for _, decl := range parsed.Decls {
			for _, name := range declaredNames(decl) {
				if removed[name] {
					t.Errorf("%s declares %q — the default-package policy is removed", file, name)
				}
			}
		}
	}
}

// declaredNames returns the top-level identifiers one declaration introduces.
func declaredNames(decl ast.Decl) []string {
	switch d := decl.(type) {
	case *ast.FuncDecl:
		return []string{d.Name.Name}
	case *ast.GenDecl:
		var names []string
		for _, spec := range d.Specs {
			switch s := spec.(type) {
			case *ast.TypeSpec:
				names = append(names, s.Name.Name)
			case *ast.ValueSpec:
				for _, n := range s.Names {
					names = append(names, n.Name)
				}
			}
		}
		return names
	}
	return nil
}

func TestModeExtensionsRemoved_BuildInputsClean(t *testing.T) {
	dockerfile, err := os.ReadFile(filepath.Join("embedded", "docker", "Dockerfile"))
	if err != nil {
		t.Fatalf("read Dockerfile: %v", err)
	}
	df := string(dockerfile)
	for _, name := range modeExtensions {
		if strings.Contains(df, "extensions/"+name) {
			t.Errorf("Dockerfile must not special-case extensions/%s", name)
		}
	}
	for _, keep := range []string{"rm -rf /opt/cheasee-pi/.git", "npm ci --no-audit --no-fund"} {
		if !strings.Contains(df, keep) {
			t.Errorf("Dockerfile must keep %q", keep)
		}
	}

	entrypoint := readEntrypoint(t)
	for _, name := range modeExtensions {
		if strings.Contains(strings.ToLower(entrypoint), name) {
			t.Errorf("entrypoint.sh must not mention %s", name)
		}
	}
	for _, keep := range []string{"prune_stale_repo_links", "install_skill_repos"} {
		if !strings.Contains(entrypoint, keep) {
			t.Errorf("entrypoint.sh must keep %s", keep)
		}
	}

	var settings struct {
		Packages []json.RawMessage `json:"packages"`
	}
	if err := json.Unmarshal([]byte(readCommittedSettings(t)), &settings); err != nil {
		t.Fatalf("committed .pi/settings.json: %v", err)
	}
	var packages []string
	for _, entry := range settings.Packages {
		var source string
		if err := json.Unmarshal(entry, &source); err != nil {
			t.Errorf("committed packages entry must be a bare source string, got %s", entry)
			continue
		}
		packages = append(packages, source)
	}
	want := []string{"https://github.com/SchneiderDaniel/private-pi"}
	if strings.Join(packages, ",") != strings.Join(want, ",") {
		t.Errorf("committed packages = %v, want %v", packages, want)
	}

	workflow, err := os.ReadFile(filepath.Join(modeRepoRoot(), ".github", "workflows", "tests.yml"))
	if err != nil {
		t.Fatalf("read tests.yml: %v", err)
	}
	for _, name := range modeExtensions {
		if strings.Contains(strings.ToLower(string(workflow)), name) {
			t.Errorf("tests.yml must not install or mention %s", name)
		}
	}
	if !strings.Contains(string(workflow), "npm install -g @ast-grep/cli") {
		t.Error("tests.yml must keep the ast-grep install the node suite needs")
	}
}

// ponytailSource is the exact package source the harness no longer records.
// It stays a literal here so the guide contract cannot drift with the doc.
const ponytailSource = "https://github.com/DietrichGebert/ponytail"

// ponytailClonePath is the project-local checkout `pi install -l` creates. The
// cleanup path names this path and never the parent directory, which also
// holds user-installed skill clones.
const ponytailClonePath = ".pi/git/github.com/DietrichGebert/ponytail"

func TestModeExtensionsRemoved_InstallGuideCleanupPath(t *testing.T) {
	path := filepath.Join(modeRepoRoot(), "docs", "installation.md")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read docs/installation.md: %v", err)
	}
	guide := string(data)

	// The cleanup path is the one place an operator can still be running
	// Ponytail, so it must be an executable, ordered procedure.
	section, ok := guideSection(guide, "### Upgrade from a Ponytail release")
	if !ok {
		t.Fatal("docs/installation.md must carry a '### Upgrade from a Ponytail release' section")
	}
	uninstall := "pi uninstall " + ponytailSource
	steps := numberedSteps(section)
	if len(steps) < 4 {
		t.Fatalf("cleanup path must be an ordered list of at least 4 steps, got %d", len(steps))
	}

	// Order matters: pi uninstall first, the manual settings edit second, the
	// clone deletion third. Removing the entry by hand before uninstalling can
	// leave the checkout behind.
	for i, want := range []struct {
		needle string
		what   string
	}{
		{uninstall, "the pi uninstall command"},
		{".pi/settings.json", "the scoped settings edit"},
		{ponytailClonePath, "the scoped clone deletion"},
		{"jq -r '.packages'", "the verification command"},
	} {
		if !strings.Contains(steps[i], want.needle) {
			t.Errorf("cleanup step %d must carry %s (%q)", i+1, want.what, want.needle)
		}
	}
	if !hasLinePrefixedBy(steps[0], uninstall) {
		t.Errorf("cleanup step 1 must carry %q on one line (a wrapped command is not runnable)", uninstall)
	}

	// `.pi/git` also holds user-installed skill clones: a wholesale delete would
	// destroy unrelated packages, so the guide must never suggest one.
	if strings.Contains(guide, "rm -rf .pi/git") {
		t.Error("docs/installation.md must not suggest deleting .pi/git wholesale")
	}
	// Existing Node contract: the harness no longer preinstalls a skill repo.
	if strings.Contains(strings.ToLower(guide), "installed by default") {
		t.Error("docs/installation.md must not claim a skill repository is installed by default")
	}
}

// guideSection slices the body of one markdown heading out of a doc, up to the
// next heading of the same or a higher level.
func guideSection(content, heading string) (string, bool) {
	start := strings.Index(content, heading+"\n")
	if start < 0 {
		return "", false
	}
	body := content[start+len(heading)+1:]
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "### ") || strings.HasPrefix(line, "## ") {
			return body[:strings.Index(body, line)], true
		}
	}
	return body, true
}

// numberedSteps returns the ordinal list items of a markdown section, in order.
func numberedSteps(section string) []string {
	locs := numberedStepRe.FindAllStringIndex(section, -1)
	steps := make([]string, 0, len(locs))
	for i, loc := range locs {
		end := len(section)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		steps = append(steps, section[loc[0]:end])
	}
	return steps
}

var numberedStepRe = regexp.MustCompile(`(?m)^\d+\.\s`)

// hasLinePrefixedBy reports whether some line starts with the given command
// (after a blockquote or code-fence marker), so a wrapped command cannot
// satisfy a cleanup step.
func hasLinePrefixedBy(content, prefix string) bool {
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		trimmed = strings.TrimSpace(strings.TrimPrefix(trimmed, ">"))
		trimmed = strings.TrimSpace(strings.TrimPrefix(trimmed, "```"))
		if strings.HasPrefix(trimmed, prefix) {
			return true
		}
	}
	return false
}

func TestModeExtensionsRemoved_AgentFrontmatterResolves(t *testing.T) {
	agentsDir := filepath.Join(modeRepoRoot(), ".pi", "extensions", "supervisor", "agents")
	entries, err := os.ReadDir(agentsDir)
	if err != nil {
		t.Fatalf("read agents dir: %v", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		path := filepath.Join(agentsDir, entry.Name())
		names, ok := frontmatterExtensions(path)
		if !ok {
			t.Errorf("%s: no extensions: frontmatter", entry.Name())
			continue
		}
		for _, name := range names {
			for _, removed := range modeExtensions {
				if strings.EqualFold(name, removed) {
					t.Errorf("%s still names the removed extension %q", entry.Name(), name)
				}
			}
			// supervisor is the extension that reads the frontmatter, so it never
			// names itself as a child.
			if strings.EqualFold(name, "supervisor") {
				continue
			}
			if !extensionExists(name) {
				t.Errorf("%s names %q, which resolves to no .pi/extensions entry", entry.Name(), name)
			}
		}
	}
}

// frontmatterExtensions reads the `extensions:` value out of the YAML
// frontmatter block. A hand parse keeps the test free of a YAML dependency for
// one comma-separated scalar.
func frontmatterExtensions(path string) ([]string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	lines := strings.Split(string(data), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return nil, false
	}
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "---" {
			break
		}
		key, value, found := strings.Cut(strings.TrimSpace(line), ":")
		if !found || strings.TrimSpace(key) != "extensions" {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"`)
		var names []string
		for _, name := range strings.Split(value, ",") {
			if name = strings.TrimSpace(name); name != "" {
				names = append(names, name)
			}
		}
		return names, true
	}
	return nil, false
}

// extensionExists mirrors resolveExtensionPathsWithFs's candidate order
// (.pi/extensions/<name>.ts|.js then <name>/index.ts|index.js).
func extensionExists(name string) bool {
	for _, candidate := range []string{
		filepath.Join(modeRepoRoot(), ".pi", "extensions", name+".ts"),
		filepath.Join(modeRepoRoot(), ".pi", "extensions", name+".js"),
		filepath.Join(modeRepoRoot(), ".pi", "extensions", name, "index.ts"),
		filepath.Join(modeRepoRoot(), ".pi", "extensions", name, "index.js"),
	} {
		if _, err := os.Stat(candidate); err == nil {
			return true
		}
	}
	return false
}
