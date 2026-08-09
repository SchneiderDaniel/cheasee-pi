package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Settings is the canonical schema for .pi/settings.json. Field order matches
// the embedded scaffold template (embedded/pi/settings.json) so Save output is
// byte-stable: no map-key lexicographic reordering, no HTML escaping.
//
// Skills and Prompts are hand-edited arrays that may be absent; everything else
// mirrors the scaffold. Unknown keys on load are tolerated (v1 compat), but a
// typed Save drops keys it does not declare — the "//" comment key is the one
// preserved escape hatch.
type Settings struct {
	Comment         string              `json:"//,omitempty"`
	DefaultProvider string              `json:"defaultProvider,omitempty"`
	DefaultModel    string              `json:"defaultModel,omitempty"`
	Docker          DockerSettings      `json:"docker,omitempty"`
	GitIdentity     GitIdentitySettings `json:"gitIdentity,omitempty"`
	Skills          []string            `json:"skills,omitempty"`
	Prompts         []string            `json:"prompts,omitempty"`
	Extensions      []string            `json:"extensions,omitempty"`
	Theme           string              `json:"theme,omitempty"`
	SessionDir      string              `json:"sessionDir,omitempty"`
}

// DockerSettings mirrors the "docker" section of the scaffold schema.
type DockerSettings struct {
	Memory string `json:"memory"`
	CPUs   string `json:"cpus"`
}

// GitIdentitySettings mirrors the "gitIdentity" section of the scaffold schema.
type GitIdentitySettings struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

// settingsPath returns the .pi/settings.json path for a workspace.
func settingsPath(workdir string) string {
	return filepath.Join(workdir, ".pi", "settings.json")
}

// CheaseeSettings is the canonical schema for cheasee-settings.json — the
// dedicated cheasee-pi settings file at the workspace root. Its presence is
// the "initialized" marker for the start gate, independent from pi's own
// .pi/settings.json (which pi self-scaffolds on first run). Field order
// matches the embedded scaffold template (embedded/cheasee-settings.json) so
// Save output is byte-stable.
//
// Docker/GitIdentity reuse the Settings sub-schemas — the sections moved out
// of .pi/settings.json wholesale.
type CheaseeSettings struct {
	Comment         string              `json:"//,omitempty"`
	DefaultProvider string              `json:"defaultProvider,omitempty"`
	DefaultModel    string              `json:"defaultModel,omitempty"`
	Docker          DockerSettings      `json:"docker,omitempty"`
	GitIdentity     GitIdentitySettings `json:"gitIdentity,omitempty"`
	OAuth           OAuthSettings       `json:"oauth,omitempty"`
}

// OAuthSettings mirrors the "oauth" section of the cheasee-settings.json
// scaffold (the GitHub OAuth client ID used at init time).
type OAuthSettings struct {
	ClientID string `json:"clientID"`
}

// cheaseeSettingsPath returns the cheasee-settings.json path for a workspace.
func cheaseeSettingsPath(workdir string) string {
	return filepath.Join(workdir, "cheasee-settings.json")
}

// LoadCheaseeSettings reads cheasee-settings.json from the workspace root.
// Returns os.ErrNotExist when the file is missing (caller decides how to
// react); malformed JSON or type mismatches are hard errors, never silently
// dropped.
func LoadCheaseeSettings(workdir string) (*CheaseeSettings, error) {
	data, err := os.ReadFile(cheaseeSettingsPath(workdir))
	if err != nil {
		return nil, err
	}
	var s CheaseeSettings
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// Save writes the settings atomically to cheasee-settings.json. Uses
// json.Encoder with tab indent and no HTML escaping so re-writes are
// byte-stable diffs rather than content-mutating reformats.
func (s *CheaseeSettings) Save(workdir string) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "\t")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		return err
	}
	return atomicWrite(cheaseeSettingsPath(workdir), buf.Bytes(), 0644)
}

// LoadSettings reads .pi/settings.json from the workspace. Returns
// os.ErrNotExist when the file is missing (caller decides how to react);
// malformed JSON or type mismatches are hard errors, never silently dropped.
func LoadSettings(workdir string) (*Settings, error) {
	return loadSettingsFile(settingsPath(workdir))
}

// loadSettingsFile is LoadSettings for an explicit path, reused by the
// .pi/agent/settings.json path (same package).
func loadSettingsFile(path string) (*Settings, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var s Settings
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// Save writes the settings atomically to .pi/settings.json, creating parent
// dirs as needed. Uses json.Encoder with tab indent and no HTML escaping so
// re-writes are byte-stable diffs rather than content-mutating reformats.
func (s *Settings) Save(workdir string) error {
	return saveSettingsFile(settingsPath(workdir), s)
}

// saveSettingsFile is Save for an explicit path, reused by the
// .pi/agent/settings.json path (same package).
func saveSettingsFile(path string, s *Settings) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "\t")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		return err
	}
	return atomicWrite(path, buf.Bytes(), 0644)
}

// SetDefaultProvider sets the default provider and, when non-empty, the
// default model (empty model leaves the existing defaultModel untouched).
// Returns the receiver so callers can chain: LoadSettings(...).SetDefaultProvider(...).Save(...).
func (s *Settings) SetDefaultProvider(provider, model string) *Settings {
	s.DefaultProvider = provider
	if model != "" {
		s.DefaultModel = model
	}
	return s
}

// memoryLimitEnv reads docker.memory from cheasee-settings.json and returns
// the CHEASEEPI_MEMORY env entry to apply to the docker compose command.
// Missing file or empty memory → ("", false) with no output, preserving
// today's silent skip; corrupt JSON → warning on stderr and ("", false) —
// the limit is advisory, never fatal.
func memoryLimitEnv(workdir string) (string, bool) {
	settings, err := LoadCheaseeSettings(workdir)
	if err != nil {
		if !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "  ⚠ Could not read cheasee-settings.json: %v\n", err)
		}
		return "", false
	}
	if settings.Docker.Memory == "" {
		return "", false
	}
	return "CHEASEEPI_MEMORY=" + settings.Docker.Memory, true
}

// envValue returns the value part of a KEY=value entry.
func envValue(env string) string {
	_, v, _ := strings.Cut(env, "=")
	return v
}
