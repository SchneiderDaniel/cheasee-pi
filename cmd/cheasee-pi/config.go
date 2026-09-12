package main

import (
	"context"
	"encoding/json"
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
