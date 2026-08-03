package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"charm.land/huh/v2"
)

// runInitSubmodule orchestrates submodule setup.
// Interactive flow (noInput=false): asks yes/no, count, entries, adds each.
// Non-interactive flow (noInput=true or confirmFn nil): reads .gitmodules, applies CLI overrides.
func runInitSubmodule(
	ctx context.Context,
	ops submoduleOps,
	workdir string,
	urlOverrides map[string]string,
	skipAll bool,
	promptFn func([]Submodule) (map[string]string, error),
	noInput bool,
	confirmFn func(string) (bool, error),
	inputFn func(title, placeholder string) (string, error),
) error {
	if skipAll {
		fmt.Fprintf(os.Stderr, "  ℹ Skipping submodule setup (--skip-submodules)\n")
		return nil
	}

	// Interactive flow: ask user what submodules they want
	if !noInput && confirmFn != nil && inputFn != nil {
		ok, err := confirmFn("Set up git submodules?")
		if err != nil {
			return err
		}
		if !ok {
			fmt.Fprintf(os.Stderr, "  ℹ Skipping submodule setup\n")
			// Remove submodule directories
			removeSubmoduleDirs(workdir)
			// Remove .gitmodules if present
			if err := os.Remove(filepath.Join(workdir, ".gitmodules")); err == nil {
				fmt.Fprintf(os.Stderr, "  ✓ Removed .gitmodules\n")
			}
			// Clean submodule paths from .pi/settings.json
			if err := removeSubmoduleSettings(workdir); err != nil {
				return fmt.Errorf("clean submodule settings: %w", err)
			}
			return nil
		}

		// Remove original submodules before setting up user's own
		removeSubmoduleDirs(workdir)
		if err := os.Remove(filepath.Join(workdir, ".gitmodules")); err == nil {
			fmt.Fprintf(os.Stderr, "  ✓ Removed original .gitmodules\n")
		}

		countStr, err := inputFn("How many submodules?", "0")
		if err != nil {
			return err
		}
		count := 0
		if countStr != "" {
			fmt.Sscanf(countStr, "%d", &count)
		}

		for i := 0; i < count; i++ {
			name, err := inputFn(fmt.Sprintf("Submodule %d — name (directory path)", i+1), "")
			if err != nil {
				return err
			}
			url, err := inputFn(fmt.Sprintf("Submodule %d — repository URL", i+1), "")
			if err != nil {
				return err
			}
			if name == "" || url == "" {
				fmt.Fprintf(os.Stderr, "  ⚠ Skipping submodule %d — name or URL empty\n", i+1)
				continue
			}

			// URL override from CLI flag takes precedence
			if override, ok := urlOverrides[name]; ok {
				url = override
			}

			fmt.Fprintf(os.Stderr, "  ℹ Adding submodule %s → %s\n", name, url)
			if err := ops.AddSubmodule(ctx, workdir, name, url); err != nil {
				return fmt.Errorf("add submodule %q: %w", name, err)
			}
		}

		if count > 0 {
			if err := ops.InitAndUpdateSubmodules(ctx, workdir); err != nil {
				return fmt.Errorf("update submodules: %w", err)
			}
		}

		fmt.Fprintf(os.Stderr, "  ✓ Submodules configured\n")
		return nil
	}

	// Non-interactive flow: read from .gitmodules, apply overrides
	fmt.Fprintf(os.Stderr, "  ℹ Configuring submodules...\n")

	submodules, err := ops.ListSubmodules(ctx, workdir)
	if err != nil {
		return fmt.Errorf("list submodules: %w", err)
	}

	if len(submodules) == 0 {
		fmt.Fprintf(os.Stderr, "  ℹ No submodules found\n")
		return nil
	}

	// Collect URL overrides: prompt first, then CLI flags take precedence
	overrides := make(map[string]string)
	if promptFn != nil {
		promptResult, err := promptFn(submodules)
		if err != nil {
			return fmt.Errorf("prompt for submodule URLs: %w", err)
		}
		for name, url := range promptResult {
			overrides[name] = url
		}
	}
	for name, url := range urlOverrides {
		overrides[name] = url
	}

	// Apply URL changes
	for name, url := range overrides {
		fmt.Fprintf(os.Stderr, "  ℹ Setting submodule %q URL to %s\n", name, url)
		if err := ops.SetSubmoduleURL(ctx, workdir, name, url); err != nil {
			return fmt.Errorf("set submodule %q URL: %w", name, err)
		}
	}

	// Init and update all submodules
	if err := ops.InitAndUpdateSubmodules(ctx, workdir); err != nil {
		return fmt.Errorf("update submodules: %w", err)
	}

	fmt.Fprintf(os.Stderr, "  ✓ Submodules configured\n")
	return nil
}

// removeSubmoduleDirs reads .gitmodules and removes submodule directories.
func removeSubmoduleDirs(workdir string) {
	gitmodulesPath := filepath.Join(workdir, ".gitmodules")
	data, err := os.ReadFile(gitmodulesPath)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "path = ") {
			path := strings.TrimPrefix(line, "path = ")
			fullPath := filepath.Join(workdir, path)
			if err := os.RemoveAll(fullPath); err == nil {
				fmt.Fprintf(os.Stderr, "  ✓ Removed submodule directory %s\n", path)
			}
		}
	}
}

// removeSubmoduleSettings removes entries referencing submodule paths
// (.g./../private-pi/skills) from .pi/settings.json skills and prompts arrays.
// Writes atomically via Settings.Save, and only when something was removed.
func removeSubmoduleSettings(workdir string) error {
	settings, err := LoadSettings(workdir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	changed := false
	filter := func(entries []string) []string {
		filtered := make([]string, 0, len(entries))
		for _, s := range entries {
			// Drop entries that reference parent directories (submodule paths)
			if strings.HasPrefix(s, "../") || strings.HasPrefix(s, "..\\") {
				changed = true
				continue
			}
			filtered = append(filtered, s)
		}
		return filtered
	}
	settings.Skills = filter(settings.Skills)
	settings.Prompts = filter(settings.Prompts)

	if !changed {
		return nil
	}
	if err := settings.Save(workdir); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "  ✓ Removed submodule paths from .pi/settings.json\n")
	return nil
}

// runInitCloneSubmodule clones a repo and configures its submodule.
func runInitCloneSubmodule(ctx context.Context, token, cloneURL, workdir string) error {
	sourceOwner, sourceRepoName := ParseGitHubURL(cloneURL)
	if sourceOwner == "" || sourceRepoName == "" {
		return fmt.Errorf("invalid clone URL: %s", cloneURL)
	}

	// Check if target dir already has content
	if fi, err := os.Stat(workdir); err == nil && fi.IsDir() {
		entries, _ := os.ReadDir(workdir)
		if len(entries) > 0 {
			// Has .git → repo exists, skip clone
			if _, err := os.Stat(filepath.Join(workdir, ".git")); err == nil {
				fmt.Fprintf(os.Stderr, "  ℹ Repository already exists at %s, skipping clone\n", workdir)
				return nil
			}
			// Non-empty, no .git → refuse
			return fmt.Errorf("directory %s exists and is not empty. Remove it or use --workdir to point elsewhere", workdir)
		}
	}

	if err := gitCloneWorktree(ctx, token, cloneURL, workdir); err != nil {
		return fmt.Errorf("clone fork: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  ✓ Cloned %s/%s to %s\n", sourceOwner, sourceRepoName, workdir)
	return nil
}

// parseSubmoduleURLs parses --submodule-url flag values (format: name=url).
func parseSubmoduleURLs(entries []string) (map[string]string, error) {
	result := make(map[string]string, len(entries))
	for _, entry := range entries {
		parts := strings.SplitN(entry, "=", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid --submodule-url format: %q (expected name=url)", entry)
		}
		name := strings.TrimSpace(parts[0])
		url := strings.TrimSpace(parts[1])
		if name == "" {
			return nil, fmt.Errorf("empty submodule name in %q", entry)
		}
		if url == "" {
			return nil, fmt.Errorf("empty URL for submodule %q", name)
		}
		result[name] = url
	}
	return result, nil
}

// promptSubmoduleURLs prompts the user for each submodule's URL.
// Returns a map of name→newURL for entries the user changed.
func promptSubmoduleURLs(submodules []Submodule) (map[string]string, error) {
	type entry struct {
		name       string
		defaultURL string
		url        string
	}

	entries := make([]entry, len(submodules))
	fields := make([]huh.Field, 0, len(submodules))

	for i, sm := range submodules {
		entries[i] = entry{name: sm.Name, defaultURL: sm.URL, url: sm.URL}
		fields = append(fields, huh.NewInput().
			Title(fmt.Sprintf("Submodule %q", sm.Name)).
			Description(fmt.Sprintf("Repository URL [default: %s]", sm.URL)).
			Value(&entries[i].url),
		)
	}

	if len(fields) == 0 {
		return nil, nil
	}

	form := huh.NewForm(huh.NewGroup(fields...))
	if err := form.Run(); err != nil {
		return nil, err
	}

	overrides := make(map[string]string)
	for _, e := range entries {
		if e.url != "" && e.url != e.defaultURL {
			overrides[e.name] = e.url
		}
	}
	return overrides, nil
}
