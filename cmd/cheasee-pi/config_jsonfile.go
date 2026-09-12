package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// atomicWrite writes data to path atomically via .tmp + rename.
// The temp file is fsynced before the rename and the parent dir after, so a
// crash cannot leave a 0-byte or partial file behind. Dir sync is best-effort
// (ENOTSUP/Windows) and ignored.
//
// preserveMode opts into inheriting an existing target's permission bits
// across the rename (which replaces the inode): true for user-editable
// settings files, so a user-chmod'd 0600/0640 file survives the next save
// instead of silently resetting to the caller's perm. False for credential
// files (auth.json): the caller's perm is authoritative, so a pre-existing
// world-readable mode is clamped (0600), never inherited. New files always
// get perm. Stat failures other than NotExist are surfaced, not swallowed.
func atomicWrite(path string, data []byte, perm os.FileMode, preserveMode bool) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	if preserveMode {
		if fi, err := os.Stat(path); err == nil {
			perm = fi.Mode().Perm()
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, perm); err != nil {
		return err
	}
	// fsync the temp file so the rename never publishes a partial write.
	f, err := os.OpenFile(tmpPath, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	f.Close()
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	// Best-effort parent-dir sync so the rename itself is durable; ignored
	// on platforms/filesystems that reject directory fsync.
	if d, err := os.Open(dir); err == nil {
		d.Sync() //nolint:errcheck
		d.Close()
	}
	return nil
}

// reservedAuthKeys are the top-level auth.json fields that are not provider
// entries. Enumerated once here; AddProvider/SetLegacyAuth refuse them
// (fail-closed against the `pi auth add github_token` clobber foot-gun) and
// ListProviders filters them.
var reservedAuthKeys = map[string]struct{}{
	"github_token": {},
	"github_user":  {},
	"repo_path":    {},
	"api_key":      {},
}

// isReservedAuthKey reports whether key names a reserved auth.json field
// rather than a provider entry.
func isReservedAuthKey(key string) bool {
	_, ok := reservedAuthKeys[key]
	return ok
}

// readJSONFile unmarshals the auth config file into v. found=false exactly
// when the file does not exist (v untouched); a 0-byte or malformed file
// errors instead (fail-closed: corrupt auth.json is never read as zero-value
// where a write could clobber it). v is populated, not merged — callers must
// pass a fresh value.
func (r *fileRepository) readJSONFile(v any) (found bool, err error) {
	path, err := r.configPath()
	if err != nil {
		return false, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(data, v)
}

// writeJSONFile marshals v and writes it atomically with the auth.json
// perms: 0700 parent dir, 0600 file, no .tmp residue. The MkdirAll(dir, 0700)
// is load-bearing — atomicWrite's internal MkdirAll(dir, 0755) is a no-op
// behind it and the config dir must stay private.
func (r *fileRepository) writeJSONFile(v any) error {
	path, err := r.configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	// Auth never inherits an existing target's mode: credentials must stay
	// clamped to 0600 even if a legacy/accidental write left auth.json at 0644.
	return atomicWrite(path, data, 0600, false)
}

// readRawMap reads the auth config file as a raw JSON map.
// Returns empty map if file does not exist.
func (r *fileRepository) readRawMap() (map[string]json.RawMessage, error) {
	raw := make(map[string]json.RawMessage)
	if _, err := r.readJSONFile(&raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// writeRawMap writes a raw JSON map to the auth config file atomically.
func (r *fileRepository) writeRawMap(raw map[string]json.RawMessage) error {
	return r.writeJSONFile(raw)
}

// dedupeKey detects if a key was accidentally pasted twice (first half == second
// half) and returns only the first half. No-op for normal keys.
func dedupeKey(key string) string {
	if len(key) >= 4 && len(key)%2 == 0 {
		half := len(key) / 2
		if key[:half] == key[half:] {
			return key[:half]
		}
	}
	return key
}
