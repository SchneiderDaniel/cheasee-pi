package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// reconcileDefaultPackageFilters upgrades the default package's entry in the
// project .pi/settings.json from pi's bare-string form ("load everything the
// manifest declares") to the object form carrying a skills filter, so pi's
// applyPackageFilter drops the default package's auxiliary skills. runUpE calls
// it before the container entrypoint's `pi install` (which no-ops on a source
// already present — pi compares the entry's .source) and once more after, for
// the settings file that first `pi install` itself created.
//
// cheasee-pi owns the default source's filter only: every other key and
// packages[] element is preserved via Settings.extra. An absent
// .pi/settings.json stays absent — start must not scaffold pi's file, and a
// workspace without one has no package entry to filter.
func reconcileDefaultPackageFilters(workdir string) error {
	s, err := LoadSettings(workdir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read %s: %w", settingsPath(workdir), err)
	}
	changed, err := applyDefaultPackageFilters(s)
	if err != nil {
		return fmt.Errorf("%s: %w", settingsPath(workdir), err)
	}
	if !changed {
		return nil
	}
	if err := s.Save(workdir); err != nil {
		return fmt.Errorf("write %s: %w", settingsPath(workdir), err)
	}
	return nil
}

// packageFilterObject is pi's object-form package declaration: the source plus
// the per-resource-type pattern lists. Only skills is ever set here, so every
// other resource type keeps loading its manifest default.
type packageFilterObject struct {
	Source string   `json:"source"`
	Skills []string `json:"skills"`
}

// applyDefaultPackageFilters rewrites the packages[] elements matching
// defaultPackageFilters and reports whether the settings changed.
func applyDefaultPackageFilters(s *Settings) (bool, error) {
	key, raw := settingsExtra(s, "packages")
	if key == "" {
		key = "packages"
	}
	var entries []json.RawMessage
	if raw != nil {
		if err := json.Unmarshal(raw, &entries); err != nil {
			return false, fmt.Errorf("packages must be an array: %w", err)
		}
	}

	changed := false
	for _, f := range defaultPackageFilters {
		present := false
		for i, entry := range entries {
			src, isString, ok := packageEntrySource(entry)
			if !ok || !samePackageSource(src, f.Source) {
				continue
			}
			present = true
			// Only the bare string is ours to upgrade. An object entry is
			// pi's/user's explicit resource config; a variant source (.git,
			// @ref) is left alone so no duplicate entry for the same repo
			// is appended.
			if isString && src == f.Source {
				obj, err := encodePackageFilter(f)
				if err != nil {
					return false, err
				}
				entries[i] = obj
				changed = true
			}
		}
		if !present {
			obj, err := encodePackageFilter(f)
			if err != nil {
				return false, err
			}
			entries = append(entries, obj)
			changed = true
		}
	}
	if !changed {
		return false, nil
	}
	buf, err := json.Marshal(entries)
	if err != nil {
		return false, err
	}
	if s.extra == nil {
		s.extra = make(map[string]json.RawMessage, 1)
	}
	s.extra[key] = buf
	return true, nil
}

// settingsExtra looks up an unknown top-level key case-insensitively, so a
// hand-typed "Packages" is reconciled instead of duplicated.
func settingsExtra(s *Settings, name string) (string, json.RawMessage) {
	for k, v := range s.extra {
		if strings.EqualFold(k, name) {
			return k, v
		}
	}
	return "", nil
}

// packageEntrySource returns the package source of a packages[] element: the
// string itself for pi's bare form, its "source" field for the object form.
// ok is false for any other shape, which callers leave untouched.
func packageEntrySource(entry json.RawMessage) (src string, isString, ok bool) {
	var s string
	if err := json.Unmarshal(entry, &s); err == nil {
		return s, true, true
	}
	var obj struct {
		Source string `json:"source"`
	}
	if err := json.Unmarshal(entry, &obj); err == nil && obj.Source != "" {
		return obj.Source, false, true
	}
	return "", false, false
}

// samePackageSource compares two package sources ignoring a trailing ".git"
// and an "@ref" pin, so a hand-edited variant of the default source counts as
// already present.
func samePackageSource(a, b string) bool {
	return packageSourceKey(a) == packageSourceKey(b)
}

func packageSourceKey(s string) string {
	s = strings.TrimSuffix(strings.TrimSuffix(strings.TrimSpace(s), "/"), ".git")
	// Only a ref pin binds when the "@" follows the last path segment —
	// git@host:path and user@host forms must not lose their user.
	if i := strings.LastIndex(s, "@"); i > strings.LastIndex(s, "/") {
		s = s[:i]
	}
	return s
}

// encodePackageFilter renders the pi object form of a filter. Only an
// unmarshalable source or pattern can fail, and neither can (both are plain
// strings), so the error simply propagates rather than being swallowed.
func encodePackageFilter(f defaultPackageFilter) (json.RawMessage, error) {
	buf, err := json.Marshal(packageFilterObject{Source: f.Source, Skills: f.Skills})
	if err != nil {
		return nil, fmt.Errorf("encode package filter for %s: %w", f.Source, err)
	}
	return buf, nil
}
