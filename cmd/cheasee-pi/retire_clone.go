package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The checkout side of the retirement: inspect the path without following it,
// then delete exactly that directory.

// retireCloneState is what the checkout path looks like on disk. Present reports
// whether the checkout exists; Unsafe names the first component beneath the
// workspace that is a symlink (or a parent that is not a directory), so the
// deletion would reach outside the workspace.
type retireCloneState struct {
	Present bool
	Unsafe  string
}

// retiredCloneComponents splits retiredCloneRel into the prefixes the walk
// visits, shallowest first: `.pi`, `.pi/git`, … up to the checkout itself. Every
// one of them is checked, because a symlinked *parent* redirects os.RemoveAll
// just as effectively as a symlinked leaf.
func retiredCloneComponents() []string {
	parts := strings.Split(retiredCloneRel, "/")
	out := make([]string, 0, len(parts))
	for i := range parts {
		out = append(out, strings.Join(parts[:i+1], "/"))
	}
	return out
}

// inspectRetiredClone classifies the checkout path without following any
// component. A missing component means nothing exists at or below it, so there
// is nothing to delete; a link anywhere on the way down is reported as Unsafe
// rather than followed.
func inspectRetiredClone(root string) (retireCloneState, error) {
	var state retireCloneState
	for _, rel := range retiredCloneComponents() {
		info, err := os.Lstat(filepath.Join(root, rel))
		if err != nil {
			if os.IsNotExist(err) {
				return state, nil
			}
			return state, fmt.Errorf("inspect %s: %w", rel, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			state.Present = rel == retiredCloneRel
			state.Unsafe = rel
			return state, nil
		}
		if rel == retiredCloneRel {
			state.Present = true
			return state, nil
		}
		if !info.IsDir() {
			// A regular file where a parent directory belongs: no checkout can live
			// beneath it, so there is nothing to remove.
			return state, nil
		}
	}
	return state, nil
}

// removeRetiredClone deletes exactly the checkout, after the caller's inspection
// found no symlink on the way down. The path is re-inspected here because that
// inspection and this deletion are separate steps: a component swapped to a link
// in between would otherwise be followed. RemoveAll itself unlinks a final symlink
// instead of following it, so the leaf cannot redirect the deletion either.
func removeRetiredClone(root string) error {
	state, err := inspectRetiredClone(root)
	if err != nil {
		return err
	}
	if state.Unsafe != "" {
		return unsafeCloneError(state)
	}
	if err := os.RemoveAll(filepath.Join(root, retiredCloneRel)); err != nil {
		return fmt.Errorf("remove %s: %w", retiredCloneRel, err)
	}
	return nil
}

// unsafeCloneError is the refusal an unsafe inspection produces: the operator has
// to look at that component, because the migration cannot tell where it leads.
func unsafeCloneError(state retireCloneState) error {
	return fmt.Errorf("refusing to remove %s: %s beneath the workspace is a symlink or not a directory, so deleting would reach outside it — inspect and remove that path yourself",
		retiredCloneRel, state.Unsafe)
}
