package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
)

// Auth represents the API key authentication configuration.
type Auth struct {
	APIKey string `json:"api_key"`
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
