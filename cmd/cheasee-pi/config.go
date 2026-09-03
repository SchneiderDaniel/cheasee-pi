package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// fileRepository persists and reads the auth config as a JSON file on disk.
// One dialect: fileRepository owns the raw-map patch module
// (readRawMap / writeRawMap / updateAuth) and every caller goes through it,
// so multi-provider files survive all mutations — the typed codec that
// clobbered all but one provider is gone.
type fileRepository struct{}

func (r *fileRepository) configPath() (string, error) {
	userConfigDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(userConfigDir, "cheasee-pi", "auth.json"), nil
}

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

// Path returns the full path to the auth config file.
func (r *fileRepository) Path() (string, error) {
	return r.configPath()
}

// updateAuth is the single read-merge-write chokepoint for auth.json: every
// writer reads the current map, applies its patch via fn, then atomically
// rewrites. Malformed existing content errors before any write, so a corrupt
// auth.json is never overwritten. Cross-process writer serialization (flock)
// lands here later if parallel cheasee-pi processes become a use case.
// ponytail: single-writer assumption; serialize here if that ever breaks.
func (r *fileRepository) updateAuth(ctx context.Context, fn func(map[string]json.RawMessage) error) error {
	raw, err := r.readRawMap()
	if err != nil {
		return err
	}
	if err := fn(raw); err != nil {
		return err
	}
	return r.writeRawMap(raw)
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

// GitHubToken returns the github_token from auth.json. Missing file and
// absent key both yield ("", nil) — the fail-to-fallback behavior pi up
// relies on for GH_TOKEN assembly; malformed content errors instead.
func (r *fileRepository) GitHubToken(ctx context.Context) (string, error) {
	raw, err := r.readRawMap()
	if err != nil {
		return "", err
	}
	rawToken, ok := raw["github_token"]
	if !ok {
		return "", nil
	}
	var token string
	if err := json.Unmarshal(rawToken, &token); err != nil {
		return "", err
	}
	return token, nil
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

// AddProvider adds or updates a provider API key in the auth config.
// Other providers and GitHub token fields are preserved.
func (r *fileRepository) AddProvider(ctx context.Context, provider, key string) error {
	if isReservedAuthKey(provider) {
		return fmt.Errorf("provider name %q is reserved for an auth.json field and cannot be used as a provider", provider)
	}
	key = dedupeKey(key) // guard against accidental double-paste

	return r.updateAuth(ctx, func(raw map[string]json.RawMessage) error {
		// Build the provider entry: {"<provider>": {"key": "..."}}
		entry, _ := json.Marshal(map[string]string{"key": key})
		raw[provider] = entry
		return nil
	})
}

// UpdateGitHubAuth patches the github_token, github_user, and repo_path
// fields in the auth config, preserving all provider entries and the legacy
// flat api_key. Missing auth.json → creates a file containing only the
// github fields. Merge-safe by construction (raw-map patch, same as
// AddProvider).
func (r *fileRepository) UpdateGitHubAuth(ctx context.Context, token, user, repoPath string) error {
	return r.updateAuth(ctx, func(raw map[string]json.RawMessage) error {
		for key, val := range map[string]string{
			"github_token": token,
			"github_user":  user,
			"repo_path":    repoPath,
		} {
			enc, err := json.Marshal(val)
			if err != nil {
				return err
			}
			raw[key] = enc
		}
		return nil
	})
}

// SetLegacyAuth writes the legacy init credentials (--no-github or the
// device-flow fallback) as a merge-safe raw-map patch: the per-provider
// entry {"<provider>": {"key": …}}, the flat api_key, and repo_path — the
// legacy top-level api_key write becomes one more raw-map key. Preserves
// every provider entry and the github fields; the typed Save it replaces
// was a whole-file reset that clobbered them.
func (r *fileRepository) SetLegacyAuth(ctx context.Context, provider, apiKey, repoPath string) error {
	if isReservedAuthKey(provider) {
		return fmt.Errorf("provider name %q is reserved for an auth.json field and cannot be used as a provider", provider)
	}
	apiKey = dedupeKey(apiKey) // guard against accidental double-paste

	return r.updateAuth(ctx, func(raw map[string]json.RawMessage) error {
		entry, _ := json.Marshal(map[string]string{"key": apiKey})
		raw[provider] = entry
		apiKeyJSON, _ := json.Marshal(apiKey)
		raw["api_key"] = apiKeyJSON
		repoPathJSON, _ := json.Marshal(repoPath)
		raw["repo_path"] = repoPathJSON
		return nil
	})
}

// RemoveProvider deletes a provider entry from the auth config.
func (r *fileRepository) RemoveProvider(ctx context.Context, provider string) error {
	if isReservedAuthKey(provider) {
		return fmt.Errorf("provider name %q is reserved for an auth.json field and cannot be removed", provider)
	}
	return r.updateAuth(ctx, func(raw map[string]json.RawMessage) error {
		delete(raw, provider)
		return nil
	})
}

// ListProviders returns all configured provider API keys.
// Filters out the reserved (non-provider) keys.
func (r *fileRepository) ListProviders(ctx context.Context) (map[string]string, error) {
	raw, err := r.readRawMap()
	if err != nil {
		return nil, err
	}

	result := make(map[string]string)
	for k, v := range raw {
		if isReservedAuthKey(k) {
			continue
		}
		var entry struct {
			Key string `json:"key"`
		}
		if err := json.Unmarshal(v, &entry); err == nil && entry.Key != "" {
			result[k] = entry.Key
		}
	}
	return result, nil
}
