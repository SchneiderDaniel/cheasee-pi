package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 6: entrypoint seeds the gh tmpfs from the read-only secret
//
// The host's gh and cheasee-pi config directories are no longer mounted (a
// writable mount let any in-container process rewrite the host's credentials).
// Compose mounts auth.json read-only at $CHEASEE_AUTH_PATH plus gives gh a
// container-local tmpfs via $GH_CONFIG_DIR; the entrypoint is the adapter that
// translates one into the other. It holds no credential POLICY: a failed seed
// warns visibly, never aborts container start.
// ──────────────────────────────────────────────

func TestEntrypoint_GhConfigSeed_FromSecret(t *testing.T) {
	authPath := writeSecretFile(t, `{"github_token":"`+FakeGitHubToken+`"}`)
	configDir := filepath.Join(t.TempDir(), "gh-config")
	binDir, logPath, stdinPath := ghSeedHarness(t, "0")

	out, err := runBashScript(t, funcScript(t, "seed_gh_config", seedBody(binDir, authPath, configDir)))
	if err != nil {
		t.Fatalf("seed_gh_config failed: %v (%s)", err, out)
	}
	if _, statErr := os.Stat(configDir); statErr != nil {
		t.Errorf("the seed must create $GH_CONFIG_DIR before gh writes hosts.yml: %v", statErr)
	}
	if got := readIfExists(t, stdinPath); got != FakeGitHubToken {
		t.Errorf("gh received %q on stdin, want the auth.json github_token %q", got, FakeGitHubToken)
	}
	if !strings.Contains(readIfExists(t, logPath), "auth login --with-token") {
		t.Errorf("the seed must import via `gh auth login --with-token`, calls: %q", readIfExists(t, logPath))
	}
}

func TestEntrypoint_GhConfigSeed_MissingSecretWarns(t *testing.T) {
	authPath := filepath.Join(t.TempDir(), "missing-cheasee-auth")
	configDir := filepath.Join(t.TempDir(), "gh-config")
	binDir, logPath, _ := ghSeedHarness(t, "0")

	out, err := runBashScript(t, funcScript(t, "seed_gh_config", seedBody(binDir, authPath, configDir)))
	if err != nil {
		t.Fatalf("a missing credential must be non-fatal, got %v (%s)", err, out)
	}
	if !strings.Contains(out, "Warning") {
		t.Errorf("a missing credential must produce a visible warning, got %q", out)
	}
	if !strings.Contains(out, authPath) {
		t.Errorf("the warning must name the credential file %q, got %q", authPath, out)
	}
	if strings.Contains(readIfExists(t, logPath), "auth login") {
		t.Errorf("no gh login may be attempted without a credential file: %q", readIfExists(t, logPath))
	}
}

func TestEntrypoint_GhConfigSeed_GhFailureNonFatal(t *testing.T) {
	authPath := writeSecretFile(t, `{"github_token":"`+FakeGitHubToken+`"}`)
	configDir := filepath.Join(t.TempDir(), "gh-config")
	binDir, _, _ := ghSeedHarness(t, "1")

	out, err := runBashScript(t, funcScript(t, "seed_gh_config", seedBody(binDir, authPath, configDir)))
	if err != nil {
		t.Fatalf("a failing gh import must be non-fatal (container start continues), got %v (%s)", err, out)
	}
	if !strings.Contains(out, "Warning") {
		t.Errorf("a failing gh import must produce a visible warning, got %q", out)
	}
	if !strings.Contains(out, configDir) {
		t.Errorf("the warning must name the gh config dir %q so the failure is actionable, got %q", configDir, out)
	}
}

func TestEntrypoint_GhConfigSeed_NoTokenNoop(t *testing.T) {
	authPath := writeSecretFile(t, `{"anthropic":{"key":"`+FakeAPIKey+`"}}`)
	configDir := filepath.Join(t.TempDir(), "gh-config")
	binDir, logPath, _ := ghSeedHarness(t, "0")

	out, err := runBashScript(t, funcScript(t, "seed_gh_config", seedBody(binDir, authPath, configDir)))
	if err != nil {
		t.Fatalf("a token-less auth.json must be a no-op, got %v (%s)", err, out)
	}
	if calls := readIfExists(t, logPath); strings.Contains(calls, "gh ") {
		t.Errorf("no gh invocation expected without a github_token, got %q", calls)
	}
	if strings.Contains(out, "Warning") {
		t.Errorf("a token-less auth.json is normal for key-only setups — no credential warning expected, got %q", out)
	}
}

func TestEntrypoint_GhConfigSeed_NeverPrintsToken(t *testing.T) {
	// Combined stdout+stderr: the token travels on stdin only.
	authPath := writeSecretFile(t, `{"github_token":"`+FakeGitHubToken+`"}`)
	configDir := filepath.Join(t.TempDir(), "gh-config")
	binDir, _, _ := ghSeedHarness(t, "0")

	out, err := runBashScript(t, funcScript(t, "seed_gh_config", seedBody(binDir, authPath, configDir)))
	if err != nil {
		t.Fatalf("seed_gh_config failed: %v (%s)", err, out)
	}
	if strings.Contains(out, FakeGitHubToken) {
		t.Errorf("the seed must never print the credential value, got %q", out)
	}
}

func TestEntrypoint_CredentialPathsReadOnly(t *testing.T) {
	content := readEntrypoint(t)

	for _, want := range []string{
		"CHEASEE_AUTH_PATH",         // the read-only mount seam
		"/run/secrets/cheasee_auth", // its compose default (direct compose use)
		"GH_CONFIG_DIR",             // writable, container-local gh config
		"seed_gh_config",            // defined AND invoked
		"credential.helper \"!/usr/bin/gh auth git-credential\"", // git push auth retained
	} {
		if !strings.Contains(content, want) {
			t.Errorf("entrypoint must contain %q", want)
		}
	}
	if strings.Count(content, "seed_gh_config") < 2 {
		t.Error("entrypoint must define AND invoke seed_gh_config")
	}

	// The old flow read/wrote the bind-mounted host config: that path must be
	// gone — neither a read source nor a write target.
	for _, gone := range []string{"/home/agentuser/.config/cheasee-pi", "~/.config/cheasee-pi"} {
		if strings.Contains(content, gone) {
			t.Errorf("entrypoint must not reference the host config dir %q (the credential mount is a single read-only file)", gone)
		}
	}
}
