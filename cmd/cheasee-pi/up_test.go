package main

import (
	"context"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// execArgs tests — Phase 1
// ──────────────────────────────────────────────

func TestExecArgs_runsPiDirectly(t *testing.T) {
	args := execArgs(nil, "cheasee-pi")
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
	args := execArgs(nil, "cheasee-pi")
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
	args := execArgs(env, "cheasee-pi")

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
	args := execArgs(nil, "cheasee-pi")
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
	args := execArgs(env, "cheasee-pi")

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
	first := execArgs(env, "cheasee-pi")
	for i := 0; i < 10; i++ {
		if got := execArgs(env, "cheasee-pi"); !slices.Equal(got, first) {
			t.Fatalf("execArgs not deterministic on iteration %d:\n first: %v\n got:   %v", i, first, got)
		}
	}
}

func TestExecArgs_valuesSurviveUnescaped(t *testing.T) {
	env := map[string]string{"WEIRD": "a=b c$d"}
	args := execArgs(env, "cheasee-pi")
	if !slices.Contains(args, "WEIRD=a=b c$d") {
		t.Errorf("value with spaces/$/= must survive as a single argv element: %v", args)
	}
}

// ──────────────────────────────────────────────
// orphanScanBash tests — Phase 2
// ──────────────────────────────────────────────

func TestOrphanScanBash_filtersByPPid(t *testing.T) {
	if !strings.Contains(orphanScanBash, `"1"`) {
		t.Error("orphanScanBash missing PPid=1 filter")
	}
	if !strings.Contains(orphanScanBash, `$ppid`) {
		t.Error("orphanScanBash missing ppid variable")
	}
	if !strings.Contains(orphanScanBash, `awk '{print $4}'`) {
		t.Error("orphanScanBash should use awk to extract PPID from /proc/*/stat")
	}
}

func TestOrphanScanBash_anchoredCmdline(t *testing.T) {
	if strings.Contains(orphanScanBash, `*pi*`) {
		t.Error("orphanScanBash uses dangerous *pi* substring match")
	}
	if !strings.Contains(orphanScanBash, `/usr/bin/pi`) && !strings.Contains(orphanScanBash, `"pi `) {
		t.Error("orphanScanBash missing anchored /usr/bin/pi or pi pattern")
	}
}

func TestOrphanScanBash_iteratesProcStat(t *testing.T) {
	if !strings.Contains(orphanScanBash, "/proc/[0-9]*/stat") {
		t.Error("orphanScanBash should iterate /proc/[0-9]*/stat")
	}
}

func TestOrphanScanBash_swallowsESRCH(t *testing.T) {
	if !strings.Contains(orphanScanBash, "2>/dev/null") {
		t.Error("orphanScanBash should swallow errors on kill (ESRCH)")
	}
}

func TestOrphanScanBash_echoesKilledPIDs(t *testing.T) {
	if !strings.Contains(orphanScanBash, "echo ") {
		t.Error("orphanScanBash should echo killed PIDs for user feedback")
	}
}

// ──────────────────────────────────────────────
// scanOrphans tests — Phase 3
// ──────────────────────────────────────────────

type mockCmd struct {
	outputFn   func() ([]byte, error)
	combinedFn func() ([]byte, error)
	runFn      func() error
	// Captured Set* config, for callers that configure the command
	dir    string
	env    []string
	stdout interface{ Write([]byte) (int, error) }
	stderr interface{ Write([]byte) (int, error) }
}

func (m *mockCmd) Output() ([]byte, error) {
	if m.outputFn != nil {
		return m.outputFn()
	}
	return nil, nil
}

func (m *mockCmd) CombinedOutput() ([]byte, error) {
	if m.combinedFn != nil {
		return m.combinedFn()
	}
	return nil, nil
}

func (m *mockCmd) Run() error {
	if m.runFn != nil {
		return m.runFn()
	}
	return nil
}

func (m *mockCmd) SetDir(d string)       { m.dir = d }
func (m *mockCmd) SetEnv(e []string)     { m.env = e }
func (m *mockCmd) SetStdout(w io.Writer) { m.stdout = w }
func (m *mockCmd) SetStderr(w io.Writer) { m.stderr = w }

func TestScanOrphans_containerNotRunning(t *testing.T) {
	saved := execCommand
	execCommand = func(_ string, _ ...string) cmdIface {
		return &mockCmd{
			outputFn: func() ([]byte, error) {
				return []byte(""), nil
			},
		}
	}
	defer func() { execCommand = saved }()

	count, err := scanOrphans(context.Background(), "cheasee-pi")
	if err != nil {
		t.Fatalf("scanOrphans returned error for not-running container: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 killed for not-running container, got %d", count)
	}
}

func TestScanOrphans_noOrphans(t *testing.T) {
	saved := execCommand
	step := 0
	execCommand = func(_ string, _ ...string) cmdIface {
		step++
		if step == 1 {
			return &mockCmd{
				outputFn: func() ([]byte, error) {
					return []byte("cheasee-pi"), nil
				},
			}
		}
		return &mockCmd{
			combinedFn: func() ([]byte, error) {
				return []byte(""), nil
			},
		}
	}
	defer func() { execCommand = saved }()

	count, err := scanOrphans(context.Background(), "cheasee-pi")
	if err != nil {
		t.Fatalf("scanOrphans returned error: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 killed, got %d", count)
	}
}

func TestScanOrphans_countsKilled(t *testing.T) {
	saved := execCommand
	step := 0
	execCommand = func(_ string, _ ...string) cmdIface {
		step++
		if step == 1 {
			return &mockCmd{
				outputFn: func() ([]byte, error) {
					return []byte("cheasee-pi"), nil
				},
			}
		}
		return &mockCmd{
			combinedFn: func() ([]byte, error) {
				return []byte("killing 42\nkilling 99\n"), nil
			},
		}
	}
	defer func() { execCommand = saved }()

	count, err := scanOrphans(context.Background(), "cheasee-pi")
	if err != nil {
		t.Fatalf("scanOrphans returned error: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 killed, got %d", count)
	}
}

func TestScanOrphans_dockerExecFails(t *testing.T) {
	saved := execCommand
	step := 0
	execCommand = func(_ string, _ ...string) cmdIface {
		step++
		if step == 1 {
			return &mockCmd{
				outputFn: func() ([]byte, error) {
					return []byte("cheasee-pi"), nil
				},
			}
		}
		return &mockCmd{
			combinedFn: func() ([]byte, error) {
				return nil, fmt.Errorf("container stopped")
			},
		}
	}
	defer func() { execCommand = saved }()

	_, err := scanOrphans(context.Background(), "cheasee-pi")
	if err == nil {
		t.Fatal("expected error when docker exec fails, got nil")
	}
}

func TestScanOrphans_constructsDockerExecCommand(t *testing.T) {
	saved := execCommand
	var capturedName string
	var capturedArgs []string
	step := 0
	execCommand = func(name string, arg ...string) cmdIface {
		step++
		if step == 1 {
			return &mockCmd{
				outputFn: func() ([]byte, error) {
					return []byte("cheasee-pi"), nil
				},
			}
		}
		capturedName = name
		capturedArgs = arg
		return &mockCmd{
			combinedFn: func() ([]byte, error) {
				return []byte(""), nil
			},
		}
	}
	defer func() { execCommand = saved }()

	scanOrphans(context.Background(), "cheasee-pi")

	if capturedName != "docker" {
		t.Errorf("expected docker, got %q", capturedName)
	}
	if len(capturedArgs) < 4 {
		t.Fatalf("too few args: %v", capturedArgs)
	}
	if capturedArgs[0] != "exec" {
		t.Errorf("expected exec, got %q", capturedArgs[0])
	}
	if capturedArgs[1] != "cheasee-pi" {
		t.Errorf("expected container name, got %q", capturedArgs[1])
	}
	if capturedArgs[2] != "bash" || capturedArgs[3] != "-c" {
		t.Errorf("expected bash -c, got %v", capturedArgs[2:4])
	}
	if capturedArgs[4] != orphanScanBash {
		t.Errorf("expected orphanScanBash as script argument")
	}
}

func TestScanOrphans_dockerPsFails(t *testing.T) {
	saved := execCommand
	execCommand = func(_ string, _ ...string) cmdIface {
		return &mockCmd{
			outputFn: func() ([]byte, error) {
				return nil, fmt.Errorf("docker daemon not running")
			},
		}
	}
	defer func() { execCommand = saved }()

	_, err := scanOrphans(context.Background(), "cheasee-pi")
	if err == nil {
		t.Fatal("expected error when docker ps fails, got nil")
	}
}

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

// pinPassthroughEnv makes buildEnvFlags hermetic: fresh XDG_CONFIG_HOME,
// every passthrough env name cleared, and PATH pointing at a failing gh
// binary so GH_TOKEN extraction can't leak the host's real token into the map.
func pinPassthroughEnv(t *testing.T) string {
	t.Helper()
	xdg := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", xdg)
	for _, name := range AllEnvVarNames() {
		t.Setenv(name, "")
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	return xdg
}

func TestBuildEnvFlags_happyPath(t *testing.T) {
	pinPassthroughEnv(t)
	cfg := &fileRepository{}
	if err := cfg.AddProvider(context.Background(), "openai", "sk-openai-1"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}
	if err := cfg.AddProvider(context.Background(), "anthropic", "sk-ant-1"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}

	want := map[string]string{
		"OPENAI_API_KEY":    "sk-openai-1",
		"ANTHROPIC_API_KEY": "sk-ant-1",
	}
	if !maps.Equal(env, want) {
		t.Errorf("buildEnvFlags = %v, want %v", env, want)
	}
}

func TestBuildEnvFlags_resolvesClaudeAlias(t *testing.T) {
	pinPassthroughEnv(t)
	cfg := &fileRepository{}
	if err := cfg.AddProvider(context.Background(), "claude", "sk-ant-xxx"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}
	if got := env["ANTHROPIC_API_KEY"]; got != "sk-ant-xxx" {
		t.Errorf("claude alias should map to ANTHROPIC_API_KEY, got %v", env)
	}
}

func TestBuildEnvFlags_resolvesGoogleAlias(t *testing.T) {
	pinPassthroughEnv(t)
	cfg := &fileRepository{}
	if err := cfg.AddProvider(context.Background(), "google", "xxx"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}
	if got := env["GEMINI_API_KEY"]; got != "xxx" {
		t.Errorf("google alias should map to GEMINI_API_KEY, got %v", env)
	}
}

func TestBuildEnvFlags_resolvesOpenCodeAlias(t *testing.T) {
	pinPassthroughEnv(t)
	cfg := &fileRepository{}
	if err := cfg.AddProvider(context.Background(), "opencode", "xxx"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}
	if got := env["OPENCODE_API_KEY"]; got != "xxx" {
		t.Errorf("opencode alias should map to OPENCODE_API_KEY, got %v", env)
	}
}

func TestBuildEnvFlags_resolvesXaiDriftVictim(t *testing.T) {
	pinPassthroughEnv(t)
	cfg := &fileRepository{}
	if err := cfg.AddProvider(context.Background(), "xai", "xxx"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}
	if got := env["XAI_API_KEY"]; got != "xxx" {
		t.Errorf("xai should map to XAI_API_KEY, got %v", env)
	}
}

func TestBuildEnvFlags_aliasDupesCollapseToOneKey(t *testing.T) {
	pinPassthroughEnv(t)
	cfg := &fileRepository{}
	if err := cfg.AddProvider(context.Background(), "anthropic", "sk-ant-anth"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}
	if err := cfg.AddProvider(context.Background(), "claude", "sk-ant-claude"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}
	if len(env) != 1 {
		t.Fatalf("expected exactly one ANTHROPIC_API_KEY entry, got %v", env)
	}
	// Sorted provider iteration assigns claude last, so claude's key wins.
	if got := env["ANTHROPIC_API_KEY"]; got != "sk-ant-claude" {
		t.Errorf("expected claude key to win deterministic last-write, got %q", got)
	}
}

func TestBuildEnvFlags_unknownProviderPassthrough(t *testing.T) {
	pinPassthroughEnv(t)
	cfg := &fileRepository{}
	if err := cfg.AddProvider(context.Background(), "mystery", "k123"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}
	if got := env["MYSTERY_API_KEY"]; got != "k123" {
		t.Errorf("unknown provider should emit MYSTERY_API_KEY, got %v", env)
	}
}

func TestBuildEnvFlags_emptyAuthNoEnvs(t *testing.T) {
	pinPassthroughEnv(t)

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}
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
	t.Setenv("GH_TOKEN", "gho_x")
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "acct-123")

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}
	if env["GH_TOKEN"] != "gho_x" {
		t.Errorf("GH_TOKEN not passed through, got %v", env)
	}
	if env["CLOUDFLARE_ACCOUNT_ID"] != "acct-123" {
		t.Errorf("CLOUDFLARE_ACCOUNT_ID not passed through, got %v", env)
	}
}

func TestBuildEnvFlags_authWinsOverProcessEnv(t *testing.T) {
	pinPassthroughEnv(t)
	cfg := &fileRepository{}
	if err := cfg.AddProvider(context.Background(), "openai", "from-auth"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}
	t.Setenv("OPENAI_API_KEY", "from-process")

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}
	if env["OPENAI_API_KEY"] != "from-auth" {
		t.Errorf("auth.json value should win over process env, got %v", env)
	}
}

func TestBuildEnvFlags_apiKeyOverride(t *testing.T) {
	pinPassthroughEnv(t)
	cfg := &fileRepository{}
	if err := cfg.AddProvider(context.Background(), "opencode-go", "from-auth"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}
	t.Setenv("OPENCODE_API_KEY", "from-process")

	saved := upAPIKey
	upAPIKey = "session-key"
	defer func() { upAPIKey = saved }()

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}
	if env["OPENCODE_API_KEY"] != "session-key" {
		t.Errorf("--api-key should override auth.json and process env, got %v", env)
	}
}

func TestBuildEnvFlags_apiKeyInjectedWithoutProvider(t *testing.T) {
	pinPassthroughEnv(t)

	saved := upAPIKey
	upAPIKey = "session-key"
	defer func() { upAPIKey = saved }()

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}
	if env["OPENCODE_API_KEY"] != "session-key" {
		t.Errorf("--api-key should inject OPENCODE_API_KEY with no opencode provider, got %v", env)
	}
}

func TestBuildEnvFlags_ghTokenExtractionFailureSwallowed(t *testing.T) {
	pinPassthroughEnv(t) // PATH points at a failing gh; GH_TOKEN is empty.

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}
	if _, ok := env["GH_TOKEN"]; ok {
		t.Errorf("failing gh binary should not produce GH_TOKEN, got %v", env)
	}
}

func TestBuildEnvFlags_ignoresUnlistedEnvVars(t *testing.T) {
	pinPassthroughEnv(t)
	t.Setenv("SOME_UNRELATED_VAR", "should-not-appear")

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}
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

	env, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}

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
