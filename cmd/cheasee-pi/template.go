package main

import (
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"text/template"
)

// ──────────────────────────────────────────────
// Adapter: osGitIdentity
// ──────────────────────────────────────────────

type osGitIdentity struct{}

// NewGitIdentity creates a git identity resolver that shells out to git config.
func NewGitIdentity() *osGitIdentity {
	return &osGitIdentity{}
}

func (id *osGitIdentity) Lookup() (name, email string, err error) {
	// Try user.name
	nameBytes, err := runCommandContext(context.Background(), "git", "config", "--global", "user.name").Output()
	if err == nil {
		name = strings.TrimSpace(string(nameBytes))
	}

	// Try user.email
	emailBytes, err := runCommandContext(context.Background(), "git", "config", "--global", "user.email").Output()
	if err == nil {
		email = strings.TrimSpace(string(emailBytes))
	}

	return name, email, nil
}

// ──────────────────────────────────────────────
// TemplateSettingsValues
// ──────────────────────────────────────────────

// TemplateSettingsValues holds the values for settings template substitution
// (pi's .pi/settings.json and the dedicated cheasee-settings.json). ClientID,
// DefaultModel, RepositoryURL, and GitHubUser are only referenced by the
// cheasee template; the pi template ignores them (and must never reference
// the repository fields — the {{if .RepositoryURL}} guard lives in the
// cheasee template only).
type TemplateSettingsValues struct {
	Provider       string
	DefaultModel   string
	GitName        string
	GitEmail       string
	Memory         string
	CPUs           string
	ClientID       string
	RepositoryURL  string
	GitHubUser     string
	// SkillRepos are the canonical custom skill repository specs rendered into
	// the cheasee template's skillRepos array ({{if .SkillRepos}} guard — nil
	// keeps the scaffold output byte-identical to the pre-feature template).
	// The pi template must never reference it.
	SkillRepos []string
}

// ──────────────────────────────────────────────
// Adapter: templateSettingsRenderer
// ──────────────────────────────────────────────

type templateSettingsRenderer struct {
	source       fs.FS
	templatePath string
	dest         func(workdir string) string // target path for the rendered file
}

// NewCheaseeSettingsScaffold creates a settings scaffold that renders the
// embedded cheasee-settings.json template at the workspace root — the
// dedicated, gitignored cheasee-pi settings file whose presence marks the
// workspace initialized.
func NewCheaseeSettingsScaffold() *templateSettingsRenderer {
	return &templateSettingsRenderer{
		source:       embeddedFS,
		templatePath: "embedded/cheasee-settings.json",
		dest:         func(workdir string) string { return filepath.Join(workdir, "cheasee-settings.json") },
	}
}

func (r *templateSettingsRenderer) Scaffold(ctx context.Context, workdir string, vals TemplateSettingsValues) error {
	destPath := r.dest(workdir)

	// Idempotent: skip if file already exists.
	if _, err := os.Stat(destPath); err == nil {
		return nil
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	// Read embedded template.
	tmplContent, err := fs.ReadFile(r.source, r.templatePath)
	if err != nil {
		return fmt.Errorf("read embedded settings template: %w", err)
	}

	// Parse template.
	tmpl, err := template.New("settings").Parse(string(tmplContent))
	if err != nil {
		return fmt.Errorf("parse settings template: %w", err)
	}

	// Render to buffer, then write atomically (atomicWrite creates dirs and
	// fsyncs; no inline tmp/Rename/Remove dance needed).
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, vals); err != nil {
		return fmt.Errorf("execute settings template: %w", err)
	}
	if err := atomicWrite(destPath, buf.Bytes(), 0644); err != nil {
		return fmt.Errorf("write settings file: %w", err)
	}

	return nil
}
