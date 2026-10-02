package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/cobra"
)

// uiProviderEnvMapPath is the committed snapshot the Rust ui crate embeds
// (`include_str!("../provider_env_map.json")` in ui/src/auth.rs). The ui
// resolves provider keys in Rust and cannot call into this package at runtime,
// so the snapshot is drift-pinned here instead.
func uiProviderEnvMapPath() string {
	return filepath.Join("embedded", "docker", "ui", "provider_env_map.json")
}

// TestUIProviderEnvMapParity pins the committed snapshot byte-for-byte to
// `cheasee-pi auth envvars --format json` (AC1). Byte equality — not parsed
// set equality — so alias drift (google → GEMINI_API_KEY), a dropped provider,
// and a reformatted snapshot all fail the same test. emitJSONMapping is the one
// canonical emitter; ProviderEnvAliases() covers every KnownModels provider
// plus the claude/google/opencode aliases.
func TestUIProviderEnvMapParity(t *testing.T) {
	data, err := os.ReadFile(uiProviderEnvMapPath())
	if err != nil {
		t.Fatalf("read committed ui/provider_env_map.json: %v", err)
	}

	var want bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&want)
	if err := emitJSONMapping(cmd, ProviderEnvAliases()); err != nil {
		t.Fatalf("emitJSONMapping: %v", err)
	}

	if !bytes.Equal(data, want.Bytes()) {
		t.Errorf("ui/provider_env_map.json drifted from `auth envvars --format json`\n got:\n%s\nwant:\n%s",
			data, want.Bytes())
	}
}
