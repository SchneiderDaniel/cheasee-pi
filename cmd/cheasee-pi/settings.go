package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Settings holds cheasee-pi managed fields in .pi/settings.json. Save output
// is byte-stable and does not HTML-escape values.
//
// Skills and Prompts are hand-edited arrays that may be absent; everything else
// mirrors the scaffold. Unknown keys are preserved across load/save so
// cheasee-pi never removes pi or extension configuration it does not own.
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

	extra map[string]json.RawMessage
}

// DockerSettings mirrors the "docker" section of the scaffold schema.
// CodeflowPort pins the host-side CodeFlow port for this workspace (per-repo
// explicit config); empty = derive from the repo identity.
type DockerSettings struct {
	Memory       string `json:"memory"`
	CPUs         string `json:"cpus"`
	CodeflowPort string `json:"codeflowPort,omitempty"`
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
	Repository      *RepositorySettings `json:"repository,omitempty"`
	// SkillRepos are canonical custom skill/extension git repository specs
	// (owner/repo, https://…, or git:host/user/repo[@ref]) recorded at init
	// and installed by the container entrypoint via `pi install -l -a` — the
	// exact string pi's package mechanism accepts, stored verbatim.
	SkillRepos []string `json:"skillRepos,omitempty"`
}

// OAuthSettings mirrors the "oauth" section of the cheasee-settings.json
// scaffold (the GitHub OAuth client ID used at init time).
type OAuthSettings struct {
	ClientID string `json:"clientID"`
}

// RepositorySettings mirrors the "repository" section of the
// cheasee-settings.json scaffold: the canonical clone URL and the resolved
// GitHub login, persisted so the workspace knows what init already learned.
// Pointer on CheaseeSettings keeps the legacy no-github scaffold output
// section-free (omitempty) and Save byte-stable.
type RepositorySettings struct {
	URL  string `json:"url"`
	User string `json:"user"`
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
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	for key, value := range fields {
		if !isSettingsKey(key) {
			if s.extra == nil {
				s.extra = make(map[string]json.RawMessage)
			}
			s.extra[key] = value
		}
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
	var known bytes.Buffer
	enc := json.NewEncoder(&known)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(known.Bytes(), &fields); err != nil {
		return err
	}
	for key, value := range s.extra {
		fields[key] = value
	}

	var buf bytes.Buffer
	enc = json.NewEncoder(&buf)
	enc.SetIndent("", "\t")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(fields); err != nil {
		return err
	}
	return atomicWrite(path, buf.Bytes(), 0644)
}

func isSettingsKey(key string) bool {
	for _, known := range []string{"//", "defaultProvider", "defaultModel", "docker", "gitIdentity", "skills", "prompts", "extensions", "theme", "sessionDir"} {
		if strings.EqualFold(key, known) {
			return true
		}
	}
	return false
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
