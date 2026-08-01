package main

import (
	"context"
	"fmt"
	"io"
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
	envFlags := []string{"-e", "FOO=bar", "-e", "BAZ=qux"}
	args := execArgs(envFlags, "cheasee-pi")

	execIdx := indexOf(args, "exec")
	nameIdx := indexOf(args, "cheasee-pi")
	envEIdx := indexOf(args, "-e")

	if envEIdx < execIdx {
		t.Errorf("-e flag at %d before exec at %d", envEIdx, execIdx)
	}
	if envEIdx > nameIdx {
		t.Errorf("-e flag at %d after container name at %d", envEIdx, nameIdx)
	}

	hasFoo := false
	hasBaz := false
	for i, a := range args {
		if a == "-e" && i+1 < len(args) {
			if args[i+1] == "FOO=bar" {
				hasFoo = true
			}
			if args[i+1] == "BAZ=qux" {
				hasBaz = true
			}
		}
	}
	if !hasFoo {
		t.Error("execArgs missing env FOO=bar")
	}
	if !hasBaz {
		t.Error("execArgs missing env BAZ=qux")
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
}

func TestExecArgs_manyEnvFlags(t *testing.T) {
	var envFlags []string
	for i := 0; i < 20; i++ {
		envFlags = append(envFlags, "-e", fmt.Sprintf("KEY_%d=val_%d", i, i))
	}
	args := execArgs(envFlags, "cheasee-pi")

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

	for i := 0; i < len(envFlags); i += 2 {
		if envFlags[i] != "-e" {
			continue
		}
		found := false
		for j := 0; j < namePos; j++ {
			if args[j] == envFlags[i] && j+1 < namePos && args[j+1] == envFlags[i+1] {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("env flag %s=%s not found before container name", envFlags[i], envFlags[i+1])
		}
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
// buildEnvFlags tests — Phase 3: Alias resolution
// ──────────────────────────────────────────────

func TestBuildEnvFlags_resolvesClaudeAlias(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfg := &fileRepository{}
	if err := cfg.AddProvider(context.Background(), "claude", "sk-ant-xxx"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}

	flags, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}

	hasAnthropic := false
	for i, f := range flags {
		if f == "-e" && i+1 < len(flags) && flags[i+1] == "ANTHROPIC_API_KEY=sk-ant-xxx" {
			hasAnthropic = true
			break
		}
	}
	if !hasAnthropic {
		t.Errorf("buildEnvFlags with claude alias should produce ANTHROPIC_API_KEY=sk-ant-xxx, got %v", flags)
	}
}

func TestBuildEnvFlags_resolvesGoogleAlias(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfg := &fileRepository{}
	if err := cfg.AddProvider(context.Background(), "google", "xxx"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}

	flags, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}

	hasGemini := false
	for i, f := range flags {
		if f == "-e" && i+1 < len(flags) && flags[i+1] == "GEMINI_API_KEY=xxx" {
			hasGemini = true
			break
		}
	}
	if !hasGemini {
		t.Errorf("buildEnvFlags with google alias should produce GEMINI_API_KEY=xxx, got %v", flags)
	}
}

func TestBuildEnvFlags_resolvesOpenCodeAlias(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfg := &fileRepository{}
	if err := cfg.AddProvider(context.Background(), "opencode", "xxx"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}

	flags, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}

	hasOpenCode := false
	for i, f := range flags {
		if f == "-e" && i+1 < len(flags) && flags[i+1] == "OPENCODE_API_KEY=xxx" {
			hasOpenCode = true
			break
		}
	}
	if !hasOpenCode {
		t.Errorf("buildEnvFlags with opencode alias should produce OPENCODE_API_KEY=xxx, got %v", flags)
	}
}

func TestBuildEnvFlags_resolvesXaiDriftVictim(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfg := &fileRepository{}
	if err := cfg.AddProvider(context.Background(), "xai", "xxx"); err != nil {
		t.Fatalf("seed auth.json: %v", err)
	}

	flags, err := buildEnvFlags(context.Background())
	if err != nil {
		t.Fatalf("buildEnvFlags: %v", err)
	}

	hasXai := false
	for i, f := range flags {
		if f == "-e" && i+1 < len(flags) && flags[i+1] == "XAI_API_KEY=xxx" {
			hasXai = true
			break
		}
	}
	if !hasXai {
		t.Errorf("buildEnvFlags with xai should produce XAI_API_KEY=xxx, got %v", flags)
	}
}
