package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Checkout probe plus the settings writer.

// writeRetiredSettings persists the two settings files, in order and only when
// the plan actually changes them: `cheasee-settings.json` first (the file the
// container entrypoint reads) and `.pi/settings.json` second. Surviving
// `packages` elements are re-emitted from their raw bytes, so an unrelated entry
// keeps its key order and values.
func writeRetiredSettings(root string, cheasee *CheaseeSettings, cheaseePresent bool,
	piSettings *Settings, piPresent bool, removed []retireEntry, skillRepos []string,
	packages []json.RawMessage) error {
	removedRepos := make(map[int]bool, len(removed))
	removedPackages := make(map[int]bool, len(removed))
	for _, entry := range removed {
		if entry.Kind == retireEntrySkillRepo {
			removedRepos[entry.Index] = true
			continue
		}
		removedPackages[entry.Index] = true
	}

	if cheaseePresent && len(removedRepos) > 0 {
		kept := make([]string, 0, len(skillRepos))
		for i, spec := range skillRepos {
			if !removedRepos[i] {
				kept = append(kept, spec)
			}
		}
		cheasee.SkillRepos = kept
		if err := cheasee.Save(root); err != nil {
			return fmt.Errorf("save cheasee-settings.json: %w", err)
		}
	}

	if piPresent && len(removedPackages) > 0 {
		kept := make([]json.RawMessage, 0, len(packages))
		for i, raw := range packages {
			if !removedPackages[i] {
				kept = append(kept, raw)
			}
		}
		// A non-nil empty slice encodes as `[]`, never `null`: pi reads the
		// array back and a null would be a different shape.
		encoded, err := json.Marshal(kept)
		if err != nil {
			return fmt.Errorf("encode packages: %w", err)
		}
		if piSettings.extra == nil {
			piSettings.extra = make(map[string]json.RawMessage, 1)
		}
		piSettings.extra["packages"] = encoded
		if err := piSettings.Save(root); err != nil {
			return fmt.Errorf("save .pi/settings.json: %w", err)
		}
	}
	return nil
}

// inspectRetireClone stats the checkout path without following it: RemoveAll on
// a symlink would delete the link (harmless) but the intent is to delete the
// directory pi created, and following a link is never what an upgrade should do.
func inspectRetireClone(path string) (present, isSymlink bool, err error) {
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, false, nil
		}
		return false, false, fmt.Errorf("inspect %s: %w", retiredCloneRel, err)
	}
	return true, info.Mode()&os.ModeSymlink != 0, nil
}

// liveSessionClaims lists the sessions currently holding the workspace, read
// from the same in-use claim directory the start flow publishes on the shared
// workspace mount. A read failure is surfaced: a guard that silently degrades to
// "no live session" would rewrite settings under a running pi.
func liveSessionClaims(root string) ([]string, error) {
	dir := filepath.Join(root, ".pi", "sessions", filepath.Base(inUseClaimDir))
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read session claims: %w", err)
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		ids = append(ids, entry.Name())
	}
	return ids, nil
}
