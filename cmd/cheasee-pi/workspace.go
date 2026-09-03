package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
)

// workspaceFacts reports what both gates need: is cheasee-settings.json
// present (the initialized marker), and is the folder otherwise empty
// (.DS_Store tolerated so Finder-touched folders still auto-init). The
// marker check short-circuits — an initialized workspace has files by
// design, so the empty probe is skipped.
//
// Fail-closed on the marker stat: a non-NotExist error (e.g. EACCES) is
// propagated, never treated as "marker absent" — matching the sibling
// ancestor-walker resolveStartWorkspace.
//
// firstEntry is the lexicographically first non-.DS_Store name (os.ReadDir
// sorts by filename, so the name is deterministic) — used by runInitProbe to
// keep its "found %q" refusal byte-identical.
func workspaceFacts(workdir string) (settingsPresent, empty bool, firstEntry string, err error) {
	_, serr := os.Stat(cheaseeSettingsPath(workdir))
	if serr == nil {
		return true, false, "", nil
	}
	if !errors.Is(serr, fs.ErrNotExist) {
		return false, false, "", fmt.Errorf("check workspace marker %q: %w", cheaseeSettingsPath(workdir), serr)
	}
	entries, err := os.ReadDir(workdir)
	if err != nil {
		return false, false, "", err
	}
	for _, e := range entries {
		if e.Name() == ".DS_Store" {
			continue
		}
		return false, false, e.Name(), nil
	}
	return false, true, "", nil
}
