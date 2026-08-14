package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// canonicalSkillRepo validates and normalizes a custom skill repository spec
// to the canonical form the entrypoint passes to `pi install -l -a` verbatim
// (clones land in the bind-mounted .pi/git/ and pi owns the settings
// packages array). Mirrors pi's parseGitUrl acceptance: "owner/repo"
// shorthand → https GitHub URL; git: (host/path or git@host:path) and
// https/ssh forms pass through verbatim, refs (@v1.2.3) preserved so
// `pi update` keeps pin semantics. Refuses local paths and npm: sources
// (out of scope — pi would record container-unreachable paths), bare
// scp-style git@host:path without the git: prefix (pi rejects non-protocol
// URLs lacking it), and credential-bearing URLs (the spec is persisted
// verbatim in cheasee-settings.json and echoed by the entrypoint).
func canonicalSkillRepo(spec string) (string, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return "", errors.New("empty skill repo spec")
	}
	if strings.HasPrefix(spec, "npm:") {
		return "", fmt.Errorf("invalid skill repo %q — npm: sources are not supported; use a git repository (owner/repo, https://…, or git:host/user/repo[@ref])", redactToken(spec))
	}
	if strings.HasPrefix(spec, "./") || strings.HasPrefix(spec, "../") || strings.HasPrefix(spec, "/") {
		return "", fmt.Errorf("invalid skill repo %q — local paths are not supported (they resolve on the host, not inside the container); use a git repository (owner/repo, https://…, or git:host/user/repo[@ref])", redactToken(spec))
	}
	// Credential-bearing URLs are refused — the spec is persisted verbatim.
	// The literal ssh user "git@" is not a credential and stays allowed.
	if u, err := url.Parse(spec); err == nil && u.User != nil && u.User.Username() != "git" {
		return "", fmt.Errorf("refusing skill repo with embedded credentials (specs are persisted verbatim in settings): %s", redactToken(spec))
	}
	// Bare scp-style git@host:path needs the git: prefix — pi rejects
	// non-protocol URLs without it.
	if strings.HasPrefix(spec, "git@") {
		return "", fmt.Errorf("invalid skill repo %q — scp-style git@host:path URLs need the git: prefix (git:git@host:user/repo); accepted forms: owner/repo, https://…, ssh://…, git:host/user/repo[@ref]", redactToken(spec))
	}
	if strings.HasPrefix(spec, "git:") {
		if !strings.Contains(strings.TrimPrefix(spec, "git:"), "/") {
			return "", fmt.Errorf("invalid skill repo %q — git: needs a host/path (git:host/user/repo[@ref])", redactToken(spec))
		}
		return spec, nil
	}
	if strings.HasPrefix(spec, "https://") || strings.HasPrefix(spec, "ssh://") {
		return spec, nil
	}
	// Shorthand owner/repo → canonical https GitHub URL.
	owner, repo := ParseGitHubURL(spec)
	if owner == "" || repo == "" {
		return "", fmt.Errorf("invalid skill repo %q — expected owner/repo, an https/ssh git URL, or git:host/user/repo[@ref]", redactToken(spec))
	}
	return "https://github.com/" + owner + "/" + repo, nil
}

// recordSkillRepos additively merges canonical skill repo specs into the
// workspace cheasee-settings.json skillRepos array: existing entries are
// preserved, duplicates are not re-added, and nothing is written when there
// is no change (empty input or all-duplicate specs are byte-stable no-ops).
func recordSkillRepos(workdir string, specs []string) error {
	if len(specs) == 0 {
		return nil
	}
	settings, err := LoadCheaseeSettings(workdir)
	if err != nil {
		return fmt.Errorf("read cheasee-settings.json: %w", err)
	}
	seen := make(map[string]bool, len(settings.SkillRepos))
	for _, s := range settings.SkillRepos {
		seen[s] = true
	}
	added := false
	for _, s := range specs {
		if seen[s] {
			continue
		}
		seen[s] = true
		settings.SkillRepos = append(settings.SkillRepos, s)
		added = true
	}
	if !added {
		return nil
	}
	if err := settings.Save(workdir); err != nil {
		return fmt.Errorf("save cheasee-settings.json: %w", err)
	}
	return nil
}

// runInitSkillRepos is init Phase 6b: the repeatable custom skill repository
// prompt. Record-only by design — pi runs only inside the container (which
// does not exist at init time); the entrypoint translates the recorded specs
// to `pi install -l -a` before pi execs, letting pi own the .pi/settings.json
// packages array and clone management. --skill-repo flag specs pre-seed the
// loop; --no-input records flag specs only (no prompt). An empty/whitespace
// input answers "done"; an invalid spec fails fast naming the accepted forms.
func runInitSkillRepos(deps InitDeps) error {
	canonical := make([]string, 0, len(deps.SkillRepos))
	for _, spec := range deps.SkillRepos {
		c, err := canonicalSkillRepo(spec)
		if err != nil {
			return err
		}
		canonical = append(canonical, c)
	}
	if !deps.NoInput {
		fmt.Fprintf(os.Stderr, "\n🧩 Custom Skill Repositories\n")
		fmt.Fprintf(os.Stderr, "   ───────────────────────────\n")
		fmt.Fprintf(os.Stderr, "   Skill/extension repos are installed into the container via pi's git\n")
		fmt.Fprintf(os.Stderr, "   package mechanism (pi install -l → .pi/git/). Enter owner/repo,\n")
		fmt.Fprintf(os.Stderr, "   https://…, or git:host/user/repo[@ref]. You can add several —\n")
		fmt.Fprintf(os.Stderr, "   answer no (or leave the input empty) to stop.\n\n")
		for {
			ok, err := deps.ConfirmFn("Add a custom skill repository?")
			if err != nil {
				return fmt.Errorf("skill repo prompt: %w", err)
			}
			if !ok {
				break
			}
			spec, err := deps.InputFn("Skill repository", "owner/repo or git:host/user/repo")
			if err != nil {
				return fmt.Errorf("skill repo prompt: %w", err)
			}
			spec = strings.TrimSpace(spec)
			if spec == "" {
				break // empty input = done signal
			}
			c, err := canonicalSkillRepo(spec)
			if err != nil {
				return err
			}
			canonical = append(canonical, c)
			fmt.Fprintf(os.Stderr, "   ✓ Added %s — the prompt repeats; add another or answer no to finish.\n\n", c)
		}
	}
	if len(canonical) == 0 {
		return nil
	}
	return recordSkillRepos(deps.Workdir, canonical)
}
