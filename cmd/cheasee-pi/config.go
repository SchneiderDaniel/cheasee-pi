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
	} else if a.APIKey != "" {
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

// Repository persists and loads Auth config.
type Repository interface {
	Load(ctx context.Context) (*Auth, error)
	Save(ctx context.Context, auth *Auth) error
	Path() (string, error)
}

// fileRepository implements Repository using a JSON file on disk.
type fileRepository struct{}

// NewRepository creates a file-based Repository that stores auth.json
// under the OS user config directory (e.g. ~/.config/cheasee-pi/ on Linux).
func NewRepository() Repository {
	return &fileRepository{}
}

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

	// Atomic write: write to .tmp then rename.
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath) // best-effort cleanup
		return err
	}

	return nil
}
