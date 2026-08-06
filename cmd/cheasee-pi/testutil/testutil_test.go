package testutil

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestCaptureStderr_capturesAndRestores(t *testing.T) {
	first := CaptureStderr(t, func() { os.Stderr.WriteString("hello") })
	if first != "hello" {
		t.Fatalf("CaptureStderr = %q, want %q", first, "hello")
	}
	// Second capture must see only its own output — no leakage from the first.
	second := CaptureStderr(t, func() { os.Stderr.WriteString("world") })
	if second != "world" {
		t.Fatalf("second CaptureStderr = %q, want %q (restore failed)", second, "world")
	}
}

func TestCaptureStderr_noOutput(t *testing.T) {
	if got := CaptureStderr(t, func() {}); got != "" {
		t.Errorf("CaptureStderr with no writes = %q, want empty", got)
	}
}

func TestCaptureStderr_restoresOnPanic(t *testing.T) {
	func() {
		defer func() { _ = recover() }()
		CaptureStderr(t, func() { panic("boom") })
	}()
	// os.Stderr must be restored despite the panic — a subsequent capture
	// works and reports only its own output.
	if got := CaptureStderr(t, func() { os.Stderr.WriteString("after") }); got != "after" {
		t.Errorf("CaptureStderr after panic = %q, want %q", got, "after")
	}
}

func TestReadEnvFile_stripsQuotesAndSkipsBlankLines(t *testing.T) {
	workdir := t.TempDir()
	os.MkdirAll(filepath.Join(workdir, "docker"), 0755)
	os.WriteFile(filepath.Join(workdir, "docker", ".env"), []byte("A=1\nB=\"two\"\n\nC=three\n"), 0644)

	got := ReadEnvFile(t, workdir)
	want := map[string]string{"A": "1", "B": "two", "C": "three"}
	if len(got) != len(want) {
		t.Fatalf("ReadEnvFile = %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("ReadEnvFile[%q] = %q, want %q", k, got[k], v)
		}
	}
}

func TestReadEnvFile_empty(t *testing.T) {
	workdir := t.TempDir()
	os.MkdirAll(filepath.Join(workdir, "docker"), 0755)
	os.WriteFile(filepath.Join(workdir, "docker", ".env"), nil, 0644)
	if got := ReadEnvFile(t, workdir); len(got) != 0 {
		t.Errorf("empty .env should yield empty map, got %v", got)
	}
}

func TestWriteSettingsFile_ReadSettingsRaw_roundTripAndOverwrite(t *testing.T) {
	workdir := t.TempDir()
	WriteSettingsFile(t, workdir, `{"defaultProvider": "openai"}`)
	if raw := ReadSettingsRaw(t, workdir); raw["defaultProvider"] != "openai" {
		t.Errorf("round-trip defaultProvider = %v, want openai", raw["defaultProvider"])
	}
	// Re-write overwrites — latest content wins.
	WriteSettingsFile(t, workdir, `{"defaultProvider": "anthropic"}`)
	if raw := ReadSettingsRaw(t, workdir); raw["defaultProvider"] != "anthropic" {
		t.Errorf("overwrite defaultProvider = %v, want anthropic", raw["defaultProvider"])
	}
}

func TestSetGitConfig_hermeticSubprocess(t *testing.T) {
	SetGitConfig(t, "[user]\n\tname = Test User\n\temail = test@example.com\n")
	if os.Getenv("GIT_CONFIG_GLOBAL") == "" {
		t.Error("GIT_CONFIG_GLOBAL must point at a temp config file")
	}
	if os.Getenv("GIT_CONFIG_SYSTEM") != "/dev/null" {
		t.Errorf("GIT_CONFIG_SYSTEM = %q, want /dev/null", os.Getenv("GIT_CONFIG_SYSTEM"))
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	out, err := exec.Command("git", "config", "--global", "user.name").Output()
	if err != nil {
		t.Fatalf("git config lookup failed: %v", err)
	}
	if string(out) != "Test User\n" {
		t.Errorf("git config user.name = %q, want %q", out, "Test User\n")
	}
}

func TestRedirectConfigHome_setsToExistingDir(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/sentinel")
	got := RedirectConfigHome(t)
	if got == "" || got == "/sentinel" {
		t.Errorf("RedirectConfigHome = %q, want a fresh temp dir", got)
	}
	if os.Getenv("XDG_CONFIG_HOME") != got {
		t.Errorf("XDG_CONFIG_HOME = %q, want %q", os.Getenv("XDG_CONFIG_HOME"), got)
	}
	if _, err := os.Stat(got); err != nil {
		t.Errorf("XDG_CONFIG_HOME must point at an existing dir: %v", err)
	}
}

func TestRunCobra_outputAndError(t *testing.T) {
	okCmd := &cobra.Command{RunE: func(cmd *cobra.Command, args []string) error {
		cmd.OutOrStdout().Write([]byte("hello"))
		return nil
	}}
	out, err := RunCobra(t, okCmd)
	if err != nil {
		t.Fatalf("RunCobra returned error: %v", err)
	}
	if out != "hello" {
		t.Errorf("RunCobra output = %q, want %q", out, "hello")
	}

	// RunE error: non-nil err, partial output still captured.
	errCmd := &cobra.Command{RunE: func(cmd *cobra.Command, args []string) error {
		cmd.OutOrStdout().Write([]byte("partial"))
		return errors.New("boom")
	}}
	out, err = RunCobra(t, errCmd)
	if err == nil {
		t.Fatal("RunCobra should return the RunE error")
	}
	// Output written before the error must be captured (cobra appends usage
	// text after it — assert containment, not equality).
	if !strings.Contains(out, "partial") {
		t.Errorf("RunCobra partial output = %q, want it to contain %q", out, "partial")
	}
}
