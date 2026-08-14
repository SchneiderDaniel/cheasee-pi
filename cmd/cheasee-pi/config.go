package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
)

// Auth represents the authentication configuration.
//
// Serialization produces per-provider JSON when Provider is set:
//
//	{"<provider>": {"key": "..."}, "github_token": "...", ...}
//
// When Provider is empty (legacy or GitHub-only), the api_key field
// is written at the top level for backward compatibility.
type Auth struct {
	APIKey      string `json:"-"`
	GitHubToken string `json:"github_token,omitempty"`
	GitHubUser  string `json:"github_user,omitempty"`
	RepoPath    string `json:"repo_path,omitempty"`
	Provider    string `json:"-"`
}

// MarshalJSON implements json.Marshaler for Auth.
// When Provider is set and APIKey is non-empty, the key is written under
// a per-provider object: {"<provider>": {"key": "..."}}.
// When Provider is empty, api_key is written at the top level for backward
// compatibility.
func (a *Auth) MarshalJSON() ([]byte, error) {
	m := make(map[string]any)
	if a.Provider != "" && a.APIKey != "" {
		m[a.Provider] = map[string]string{"key": a.APIKey}
	} else if a.Provider == "" {
		m["api_key"] = a.APIKey
	}
	if a.GitHubToken != "" {
		m["github_token"] = a.GitHubToken
	}
	if a.GitHubUser != "" {
		m["github_user"] = a.GitHubUser
	}
	if a.RepoPath != "" {
		m["repo_path"] = a.RepoPath
	}
	return json.Marshal(m)
}

// UnmarshalJSON implements json.Unmarshaler for Auth.
// Supports both the per-provider format and the legacy flat format.
func (a *Auth) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	// Handle flat api_key (legacy format)
	if apiKeyRaw, ok := raw["api_key"]; ok {
		var v string
		if err := json.Unmarshal(apiKeyRaw, &v); err == nil {
			a.APIKey = v
		}
	}

	// Scan all keys — any key with a nested {"key": "..."} is a provider entry
	for k, v := range raw {
		switch k {
		case "github_token":
			json.Unmarshal(v, &a.GitHubToken) //nolint: errcheck
		case "github_user":
			json.Unmarshal(v, &a.GitHubUser) //nolint: errcheck
		case "repo_path":
			json.Unmarshal(v, &a.RepoPath) //nolint: errcheck
		case "api_key":
			// already handled above
		default:
			var entry struct {
				Key string `json:"key"`
			}
			if err := json.Unmarshal(v, &entry); err == nil && entry.Key != "" {
				a.Provider = k
				a.APIKey = entry.Key
			}
		}
	}

	return nil
}

// fileRepository persists and loads Auth config as a JSON file on disk.
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
func atomicWrite(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
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

// Load reads the auth config from disk. Returns empty Auth if file does not exist.
func (r *fileRepository) Load(_ context.Context) (*Auth, error) {
	path, err := r.configPath()
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Auth{}, nil
		}
		return nil, err
	}

	var auth Auth
	if err := json.Unmarshal(data, &auth); err != nil {
		return nil, err
	}
	return &auth, nil
}

// Save writes the auth config to disk atomically (write to .tmp then rename).
func (r *fileRepository) Save(_ context.Context, auth *Auth) error {
	auth.APIKey = dedupeKey(auth.APIKey) // guard against accidental double-paste

	path, err := r.configPath()
	if err != nil {
		return err
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	data, err := json.MarshalIndent(auth, "", "  ")
	if err != nil {
		return err
	}

	return atomicWrite(path, data, 0600)
}

// readRawAuth reads the auth config file as a raw JSON map.
// Returns empty map if file does not exist.
func (r *fileRepository) readRawMap() (map[string]json.RawMessage, error) {
	path, err := r.configPath()
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return make(map[string]json.RawMessage), nil
		}
		return nil, err
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// writeRawMap writes a raw JSON map to the auth config file atomically.
func (r *fileRepository) writeRawMap(raw map[string]json.RawMessage) error {
	path, err := r.configPath()
	if err != nil {
		return err
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	data, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}

	return atomicWrite(path, data, 0600)
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
func (r *fileRepository) AddProvider(_ context.Context, provider, key string) error {
	key = dedupeKey(key) // guard against accidental double-paste

	raw, err := r.readRawMap()
	if err != nil {
		return err
	}

	// Build the provider entry: {"<provider>": {"key": "..."}}
	entry, _ := json.Marshal(map[string]string{"key": key})
	raw[provider] = entry

	return r.writeRawMap(raw)
}

// UpdateGitHubAuth patches the github_token, github_user, and repo_path
// fields in the auth config, preserving all provider entries and the legacy
// flat api_key. Missing auth.json → creates a file containing only the
// github fields. Merge-safe by construction (raw-map patch, same as
// AddProvider).
func (r *fileRepository) UpdateGitHubAuth(_ context.Context, token, user, repoPath string) error {
	raw, err := r.readRawMap()
	if err != nil {
		return err
	}
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
	return r.writeRawMap(raw)
}

// RemoveProvider deletes a provider entry from the auth config.
func (r *fileRepository) RemoveProvider(_ context.Context, provider string) error {
	raw, err := r.readRawMap()
	if err != nil {
		return err
	}

	delete(raw, provider)
	return r.writeRawMap(raw)
}

// ListProviders returns all configured provider API keys.
// Filters out non-provider keys (github_token, github_user, repo_path, api_key).
func (r *fileRepository) ListProviders(_ context.Context) (map[string]string, error) {
	raw, err := r.readRawMap()
	if err != nil {
		return nil, err
	}

	result := make(map[string]string)
	for k, v := range raw {
		switch k {
		case "github_token", "github_user", "repo_path", "api_key":
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
