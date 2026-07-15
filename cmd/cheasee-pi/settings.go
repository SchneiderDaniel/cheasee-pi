package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ──────────────────────────────────────────────
// SettingsValues
// ──────────────────────────────────────────────

// SettingsValues holds the values for .pi/settings.json generation.
type SettingsValues struct {
	GitHubUser string
	RepoName   string
	SourceRepo string
}

// ──────────────────────────────────────────────
// Port: SettingsGenerator
// ──────────────────────────────────────────────

// SettingsGenerator writes a .pi/settings.json file with user-specific values.
type SettingsGenerator interface {
	Render(ctx context.Context, dest string, vals SettingsValues) error
}

// ──────────────────────────────────────────────
// Adapter: flatSettingsGenerator
// ──────────────────────────────────────────────

type flatSettingsGenerator struct{}

// NewSettingsGenerator creates a settings generator that reads a cloned
// .pi/settings.json, rewrites it with user-specific values, and writes it
// back atomically (write to .tmp then rename).
func NewSettingsGenerator() SettingsGenerator {
	return &flatSettingsGenerator{}
}

func (g *flatSettingsGenerator) Render(_ context.Context, dest string, vals SettingsValues) error {
	// Default RepoName
	repoName := vals.RepoName
	if repoName == "" {
		repoName = "cheasee-pi"
	}
	vals.RepoName = repoName

	// Read existing settings.json
	data, err := os.ReadFile(dest)
	if err != nil {
		return fmt.Errorf("read %s: %w", dest, err)
	}

	// Parse into generic map
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		return fmt.Errorf("parse %s: %w", dest, err)
	}

	// ── Mutate settings ──

	// Strip private-pi entries from skills array
	if skills, ok := settings["skills"].([]any); ok {
		settings["skills"] = filterPrivatePi(skills)
	}

	// Strip private-pi entries from prompts array
	if prompts, ok := settings["prompts"].([]any); ok {
		settings["prompts"] = filterPrivatePi(prompts)
	}

	// Rewrite supervisor.repo
	//
	// When GitHubUser is set (GitHub OAuth path), use <user>/<repoName>.
	// When GitHubUser is empty (legacy --no-github path), fall back to
	// SourceRepo so the value is at least pointing at the source.
	ghUser := strings.TrimSpace(vals.GitHubUser)
	var repoValue string
	if ghUser != "" {
		repoValue = ghUser + "/" + vals.RepoName
	} else {
		repoValue = vals.SourceRepo
	}

	// Get or create supervisor block
	supervisorRaw, ok := settings["supervisor"]
	if !ok || supervisorRaw == nil {
		settings["supervisor"] = map[string]any{
			"repo": repoValue,
		}
	} else if supervisor, ok := supervisorRaw.(map[string]any); ok {
		supervisor["repo"] = repoValue
		settings["supervisor"] = supervisor
	} else {
		// supervisor exists but isn't a map — replace it
		settings["supervisor"] = map[string]any{
			"repo": repoValue,
		}
	}

	// ── Write back atomically ──
	out, err := json.MarshalIndent(settings, "", "\t")
	if err != nil {
		return fmt.Errorf("marshal settings: %w", err)
	}

	dir := filepath.Dir(dest)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create settings dir: %w", err)
	}

	tmpPath := dest + ".tmp"
	if err := os.WriteFile(tmpPath, out, 0644); err != nil {
		return fmt.Errorf("write settings tmp: %w", err)
	}
	if err := os.Rename(tmpPath, dest); err != nil {
		os.Remove(tmpPath) // best-effort cleanup
		return fmt.Errorf("rename settings: %w", err)
	}

	return nil
}

// filterPrivatePi removes any string from arr that starts with "private-pi/".
func filterPrivatePi(arr []any) []any {
	filtered := make([]any, 0, len(arr))
	for _, item := range arr {
		s, ok := item.(string)
		if !ok || !strings.HasPrefix(s, "private-pi/") {
			filtered = append(filtered, item)
		}
	}
	return filtered
}
