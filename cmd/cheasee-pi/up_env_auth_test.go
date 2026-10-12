package main

import (
	"context"
	"maps"
	"testing"
)

func TestBuildEnvFlags_authGitHubTokenUsedWithoutProcessEnv(t *testing.T) {
	pinPassthroughEnv(t)
	cfg := &fileRepository{}
	if err := cfg.UpdateGitHubAuth(context.Background(), "tkn-from-auth", "octocat", ""); err != nil {
		t.Fatalf("seed github_token: %v", err)
	}

	env := buildEnvFlagsOrFatal(t)
	if got := env["GH_TOKEN"]; got != "tkn-from-auth" {
		t.Errorf("expected auth.json github_token, got %q", got)
	}
}

func TestBuildEnvFlags_noAuthTokenFallsBackToProcessEnv(t *testing.T) {
	pinPassthroughEnv(t)
	t.Setenv("GH_TOKEN", "process-token")

	env := buildEnvFlagsOrFatal(t)
	if got := env["GH_TOKEN"]; got != "process-token" {
		t.Errorf("expected process GH_TOKEN fallback when auth.json has no github_token, got %q", got)
	}
}

func TestBuildEnvFlags_authWinsOverProcessEnv(t *testing.T) {
	pinPassthroughEnv(t)
	seedAuth(t, map[string]string{"openai": "from-auth"})
	t.Setenv("OPENAI_API_KEY", "from-process")

	env := buildEnvFlagsOrFatal(t)
	if env["OPENAI_API_KEY"] != "from-auth" {
		t.Errorf("auth.json value should win over process env, got %v", env)
	}
}

func TestBuildEnvFlags_apiKeyOverride(t *testing.T) {
	pinPassthroughEnv(t)
	seedAuth(t, map[string]string{"opencode-go": "from-auth"})
	t.Setenv("OPENCODE_API_KEY", "from-process")

	saved := upAPIKey
	upAPIKey = "session-key"
	defer func() { upAPIKey = saved }()

	env := buildEnvFlagsOrFatal(t)
	if env["OPENCODE_API_KEY"] != "session-key" {
		t.Errorf("--api-key should override auth.json and process env, got %v", env)
	}
}

func TestBuildEnvFlags_apiKeyInjectedWithoutProvider(t *testing.T) {
	pinPassthroughEnv(t)

	saved := upAPIKey
	upAPIKey = "session-key"
	defer func() { upAPIKey = saved }()

	env := buildEnvFlagsOrFatal(t)
	if env["OPENCODE_API_KEY"] != "session-key" {
		t.Errorf("--api-key should inject OPENCODE_API_KEY with no opencode provider, got %v", env)
	}
}

func TestBuildEnvFlags_ghTokenExtractionFailureSwallowed(t *testing.T) {
	pinPassthroughEnv(t) // PATH points at a failing gh; GH_TOKEN is empty.

	env := buildEnvFlagsOrFatal(t)
	if _, ok := env["GH_TOKEN"]; ok {
		t.Errorf("failing gh binary should not produce GH_TOKEN, got %v", env)
	}
}

func TestBuildEnvFlags_ignoresUnlistedEnvVars(t *testing.T) {
	pinPassthroughEnv(t)
	t.Setenv("SOME_UNRELATED_VAR", "should-not-appear")

	env := buildEnvFlagsOrFatal(t)
	if _, ok := env["SOME_UNRELATED_VAR"]; ok {
		t.Errorf("unlisted env var should not be passed through: %v", env)
	}
}

func TestBuildEnvFlags_allProvidersAgreeWithProviderEnvAliases(t *testing.T) {
	pinPassthroughEnv(t)
	cfg := &fileRepository{}
	for _, name := range ProviderNames() {
		if err := cfg.AddProvider(context.Background(), name, "k-"+name); err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
	}

	env := buildEnvFlagsOrFatal(t)

	want := make(map[string]string)
	for _, name := range ProviderNames() {
		if envVar := ProviderToEnvVar(name); envVar != "" {
			want[envVar] = "k-" + name
		}
	}
	if !maps.Equal(env, want) {
		t.Errorf("emitted env keys != distinct ProviderEnvAliases values:\ngot  %v\nwant %v", env, want)
	}
}
