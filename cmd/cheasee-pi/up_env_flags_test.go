package main

import (
	"context"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// buildEnvFlags tests — map shape + passthrough
// ──────────────────────────────────────────────

// buildEnvFlagsOrFatal calls buildEnvFlags, failing the test on error.
func buildEnvFlagsOrFatal(t *testing.T) map[string]string {
	t.Helper()
	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}
	return env
}

func TestBuildEnvFlags_happyPath(t *testing.T) {
	pinPassthroughEnv(t)
	seedAuth(t, map[string]string{"openai": FakeAPIKey, "anthropic": FakeAPIKeyAlt})

	env := buildEnvFlagsOrFatal(t)

	want := map[string]string{
		"OPENAI_API_KEY":    FakeAPIKey,
		"ANTHROPIC_API_KEY": FakeAPIKeyAlt,
	}
	if !maps.Equal(env, want) {
		t.Errorf("buildEnvFlags = %v, want %v", env, want)
	}
}

func TestBuildEnvFlags_resolvesClaudeAlias(t *testing.T) {
	pinPassthroughEnv(t)
	seedAuth(t, map[string]string{"claude": FakeAPIKeyAlt})

	env := buildEnvFlagsOrFatal(t)
	if got := env["ANTHROPIC_API_KEY"]; got != FakeAPIKeyAlt {
		t.Errorf("claude alias should map to ANTHROPIC_API_KEY, got %v", env)
	}
}

func TestBuildEnvFlags_resolvesGoogleAlias(t *testing.T) {
	pinPassthroughEnv(t)
	seedAuth(t, map[string]string{"google": "xxx"})

	env := buildEnvFlagsOrFatal(t)
	if got := env["GEMINI_API_KEY"]; got != "xxx" {
		t.Errorf("google alias should map to GEMINI_API_KEY, got %v", env)
	}
}

func TestBuildEnvFlags_resolvesOpenCodeAlias(t *testing.T) {
	pinPassthroughEnv(t)
	seedAuth(t, map[string]string{"opencode": "xxx"})

	env := buildEnvFlagsOrFatal(t)
	if got := env["OPENCODE_API_KEY"]; got != "xxx" {
		t.Errorf("opencode alias should map to OPENCODE_API_KEY, got %v", env)
	}
}

func TestBuildEnvFlags_resolvesXaiDriftVictim(t *testing.T) {
	pinPassthroughEnv(t)
	seedAuth(t, map[string]string{"xai": "xxx"})

	env := buildEnvFlagsOrFatal(t)
	if got := env["XAI_API_KEY"]; got != "xxx" {
		t.Errorf("xai should map to XAI_API_KEY, got %v", env)
	}
}

func TestBuildEnvFlags_aliasDupesCollapseToOneKey(t *testing.T) {
	pinPassthroughEnv(t)
	seedAuth(t, map[string]string{"anthropic": FakeAPIKey, "claude": FakeAPIKeyAlt})

	env := buildEnvFlagsOrFatal(t)
	if len(env) != 1 {
		t.Fatalf("expected exactly one ANTHROPIC_API_KEY entry, got %v", env)
	}
	// Sorted provider iteration assigns claude last, so claude's key wins.
	if got := env["ANTHROPIC_API_KEY"]; got != FakeAPIKeyAlt {
		t.Errorf("expected claude key to win deterministic last-write, got %q", got)
	}
}

func TestBuildEnvFlags_unknownProviderPassthrough(t *testing.T) {
	pinPassthroughEnv(t)
	seedAuth(t, map[string]string{"mystery": "k123"})

	env := buildEnvFlagsOrFatal(t)
	if got := env["MYSTERY_API_KEY"]; got != "k123" {
		t.Errorf("unknown provider should emit MYSTERY_API_KEY, got %v", env)
	}
}

func TestBuildEnvFlags_emptyAuthNoEnvs(t *testing.T) {
	pinPassthroughEnv(t)

	env := buildEnvFlagsOrFatal(t)
	if env == nil {
		t.Fatal("expected non-nil empty map")
	}
	if len(env) != 0 {
		t.Errorf("expected empty map, got %v", env)
	}
}

func TestBuildEnvFlags_invalidAuthReturnsWrappedError(t *testing.T) {
	xdg := pinPassthroughEnv(t)
	// auth.json as a directory: os.ReadFile fails, ListProviders errors.
	if err := os.MkdirAll(filepath.Join(xdg, "cheasee-pi", "auth.json"), 0o755); err != nil {
		t.Fatal(err)
	}

	_, err := buildEnvFlags(context.Background())
	if err == nil || !strings.Contains(err.Error(), "read auth.json") {
		t.Fatalf("expected wrapped error containing 'read auth.json', got %v", err)
	}
}

func TestBuildEnvFlags_passthroughEnvVars(t *testing.T) {
	pinPassthroughEnv(t)
	t.Setenv("GH_TOKEN", FakeGitHubToken)
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "acct-123")

	env := buildEnvFlagsOrFatal(t)
	if env["GH_TOKEN"] != FakeGitHubToken {
		t.Errorf("GH_TOKEN not passed through, got %v", env)
	}
	if env["CLOUDFLARE_ACCOUNT_ID"] != "acct-123" {
		t.Errorf("CLOUDFLARE_ACCOUNT_ID not passed through, got %v", env)
	}
}

func TestBuildEnvFlags_authGitHubTokenWinsOverProcessEnv(t *testing.T) {
	pinPassthroughEnv(t)
	cfg := &fileRepository{}
	if err := cfg.UpdateGitHubAuth(context.Background(), "tkn-from-auth", "octocat", ""); err != nil {
		t.Fatalf("seed github_token: %v", err)
	}
	t.Setenv("GH_TOKEN", "stale-process-token")

	env := buildEnvFlagsOrFatal(t)
	if got := env["GH_TOKEN"]; got != "tkn-from-auth" {
		t.Errorf("auth.json github_token should win over process env GH_TOKEN, got %q", got)
	}
}
