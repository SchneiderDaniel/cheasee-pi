package main

import (
	"context"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// Build-env flag mapping, docker exec arg construction, provider
// passthrough and env redaction. Moved verbatim from up_test.go.
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// execArgs tests — Phase 1
// ──────────────────────────────────────────────

func TestExecArgs_runsPiDirectly(t *testing.T) {
	args := execArgs(nil, "cheasee-pi", "/workspaces/main")
	joined := strings.Join(args, " ")

	checks := []string{
		"/usr/bin/pi",
		"--approve",
	}
	for _, want := range checks {
		if !strings.Contains(joined, want) {
			t.Errorf("execArgs missing %q", want)
		}
	}

	// No bash wrapper — docker exec handles cleanup on disconnect
	for _, banned := range []string{"bash -c", "setsid", "trap"} {
		if strings.Contains(joined, banned) {
			t.Errorf("execArgs should not have wrapper script (%s)", banned)
		}
	}
}

func TestExecArgs_containsExpectedOrder(t *testing.T) {
	args := execArgs(nil, "cheasee-pi", "/workspaces/main")
	joined := strings.Join(args, " ")

	checks := []string{
		"exec",
		"-it",
		"--user agentuser",
		"-w /workspaces/main",
		"cheasee-pi",
		"/usr/bin/pi",
	}
	for _, want := range checks {
		if !strings.Contains(joined, want) {
			t.Errorf("execArgs missing %q", want)
		}
	}
}

func TestExecArgs_envFlagsInCorrectPosition(t *testing.T) {
	env := map[string]string{"FOO": "bar", "BAZ": "qux"}
	args := execArgs(env, "cheasee-pi", "/workspaces/main")

	execIdx := indexOf(args, "exec")
	nameIdx := indexOf(args, "cheasee-pi")
	envEIdx := indexOf(args, "-e")

	if envEIdx < execIdx {
		t.Errorf("-e flag at %d before exec at %d", envEIdx, execIdx)
	}
	if envEIdx > nameIdx {
		t.Errorf("-e flag at %d after container name at %d", envEIdx, nameIdx)
	}

	// pairs flattened verbatim, sorted by key (BAZ < FOO)
	want := []string{"BAZ=qux", "FOO=bar"}
	for i := 0; i < len(want); i++ {
		idx := envEIdx + 2*i
		if args[idx] != "-e" || args[idx+1] != want[i] {
			t.Errorf("args[%d:%d] = %v, want [-e %s]", idx, idx+2, args[idx:idx+2], want[i])
		}
	}
}

func TestExecArgs_emptyEnvFlags(t *testing.T) {
	args := execArgs(nil, "cheasee-pi", "/workspaces/main")
	if len(args) < 6 {
		t.Fatalf("execArgs returned too few args: %v", args)
	}
	if args[0] != "exec" {
		t.Errorf("expected first arg exec, got %q", args[0])
	}
	for _, a := range args {
		if a == "-e" {
			t.Errorf("empty env map should emit no -e flags, got %v", args)
		}
	}
}

func TestExecArgs_manyEnvFlags(t *testing.T) {
	env := make(map[string]string)
	for i := 0; i < 20; i++ {
		env[fmt.Sprintf("KEY_%02d", i)] = fmt.Sprintf("val_%d", i)
	}
	args := execArgs(env, "cheasee-pi", "/workspaces/main")

	namePos := -1
	for i, a := range args {
		if a == "cheasee-pi" {
			namePos = i
			break
		}
	}
	if namePos < 0 {
		t.Fatal("container name not found")
	}

	// -e count == 2×len(map), each pair verbatim and before the container name
	// (1×"exec" + 2n env flags + "-it --user agentuser -w /workspaces/main")
	if namePos != 6+2*len(env) {
		t.Fatalf("expected %d args before container name, got %d: %v", 6+2*len(env), namePos, args)
	}
	for i, k := range slices.Sorted(maps.Keys(env)) {
		idx := 1 + 2*i
		if args[idx] != "-e" || args[idx+1] != k+"="+env[k] {
			t.Errorf("args[%d:%d] = %v, want [-e %s]", idx, idx+2, args[idx:idx+2], k+"="+env[k])
		}
	}
}

func TestExecArgs_sortedFlattenIsDeterministic(t *testing.T) {
	env := make(map[string]string)
	for i := 0; i < 25; i++ {
		env[fmt.Sprintf("KEY_%02d", i)] = fmt.Sprintf("val_%d", i)
	}
	first := execArgs(env, "cheasee-pi", "/workspaces/main")
	for i := 0; i < 10; i++ {
		if got := execArgs(env, "cheasee-pi", "/workspaces/main"); !slices.Equal(got, first) {
			t.Fatalf("execArgs not deterministic on iteration %d:\n first: %v\n got:   %v", i, first, got)
		}
	}
}

func TestExecArgs_valuesSurviveUnescaped(t *testing.T) {
	env := map[string]string{"WEIRD": "a=b c$d"}
	args := execArgs(env, "cheasee-pi", "/workspaces/main")
	if !slices.Contains(args, "WEIRD=a=b c$d") {
		t.Errorf("value with spaces/$/= must survive as a single argv element: %v", args)
	}
}

// ──────────────────────────────────────────────
// orphanScanBash tests — Phase 2
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

func indexOf(slice []string, val string) int {
	for i, s := range slice {
		if s == val {
			return i
		}
	}
	return -1
}

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

func TestAllEnvVarNames_distinctNonEmptyUnion(t *testing.T) {
	names := AllEnvVarNames()
	if len(names) == 0 {
		t.Fatal("AllEnvVarNames returned empty")
	}
	if !slices.IsSorted(names) {
		t.Errorf("AllEnvVarNames not sorted: %v", names)
	}

	seen := make(map[string]bool)
	for _, n := range names {
		if n == "" {
			t.Error("AllEnvVarNames contains an empty name")
		}
		if seen[n] {
			t.Errorf("AllEnvVarNames contains duplicate %q", n)
		}
		seen[n] = true
	}

	aliasVals := make(map[string]bool)
	for _, v := range ProviderEnvAliases() {
		if v != "" {
			aliasVals[v] = true
		}
	}
	for v := range aliasVals {
		if !seen[v] {
			t.Errorf("AllEnvVarNames missing provider env var %q", v)
		}
	}
	for _, n := range ProviderPassthroughNames {
		if !seen[n] {
			t.Errorf("AllEnvVarNames missing passthrough env var %q", n)
		}
	}
}

func TestProviderPassthroughNames_nonProviderOnly(t *testing.T) {
	want := []string{"GH_TOKEN", "CLOUDFLARE_ACCOUNT_ID"}
	if !slices.Equal(ProviderPassthroughNames, want) {
		t.Errorf("ProviderPassthroughNames = %v, want %v", ProviderPassthroughNames, want)
	}

	aliasVals := make(map[string]bool)
	for _, v := range ProviderEnvAliases() {
		aliasVals[v] = true
	}
	for _, n := range ProviderPassthroughNames {
		if aliasVals[n] {
			t.Errorf("passthrough name %q duplicates a provider env var", n)
		}
	}
}

func TestRedactEnvValue(t *testing.T) {
	if got := redactEnvValue("0123456789abc"); got != "0123...9abc" {
		t.Errorf("long value should be first4...last4, got %q", got)
	}
	if got := redactEnvValue("12345678"); got != "12345678" {
		t.Errorf("8-char value should print in full, got %q", got)
	}
	if got := redactEnvValue(""); got != "" {
		t.Errorf("empty value should print in full, got %q", got)
	}
}
