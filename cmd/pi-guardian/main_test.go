package main

import (
	"bytes"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

// ──────────────────────────────────────────────
// Unit: matchPidName
// ──────────────────────────────────────────────

func TestMatchPidName(t *testing.T) {
	tests := []struct {
		name    string
		cmdline string
		pidName string
		want    bool
	}{
		{
			name:    "exact match pi",
			cmdline: "/usr/bin/pi --approve",
			pidName: "pi",
			want:    true,
		},
		{
			name:    "partial match node pi script",
			cmdline: "node /usr/local/bin/pi-wrapper.js",
			pidName: "pi",
			want:    true,
		},
		{
			name:    "no match bash",
			cmdline: "bash",
			pidName: "pi",
			want:    false,
		},
		{
			name:    "no match nginx",
			cmdline: "nginx: master process",
			pidName: "pi",
			want:    false,
		},
		{
			name:    "empty cmdline",
			cmdline: "",
			pidName: "pi",
			want:    false,
		},
		{
			name:    "custom pid name",
			cmdline: "/usr/local/bin/my-service --flag",
			pidName: "my-service",
			want:    true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := matchPidName(tt.cmdline, tt.pidName)
			if got != tt.want {
				t.Errorf("matchPidName(%q, %q) = %v, want %v", tt.cmdline, tt.pidName, got, tt.want)
			}
		})
	}
}

// ──────────────────────────────────────────────
// Unit: readPPidFromReader / readCmdlineFromReader
// ──────────────────────────────────────────────

func TestReadPPidFromReader(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    int
		wantErr bool
	}{
		{
			name:  "normal stat",
			input: "42 (pi) S 1 42 42 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 123 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
			want:  1,
		},
		{
			name:  "different ppid",
			input: "99 (bash) S 42 99 99 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 456 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
			want:  42,
		},
		{
			name:  "comm with spaces",
			input: "100 (chrome: sandbox) S 1 100 100 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 789 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
			want:  1,
		},
		{
			name:    "malformed stat",
			input:   "100 (pi) S",
			wantErr: true,
		},
		{
			name:    "empty input",
			input:   "",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := readPPidFromReader(strings.NewReader(tt.input))
			if tt.wantErr {
				if err == nil {
					t.Errorf("readPPidFromReader() error = nil, wantErr %v", tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Errorf("readPPidFromReader() unexpected error: %v", err)
				return
			}
			if got != tt.want {
				t.Errorf("readPPidFromReader() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestReadCmdlineFromReader(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "normal cmdline",
			input: "/usr/bin/pi\x00--approve\x00",
			want:  "/usr/bin/pi --approve",
		},
		{
			name:  "single arg",
			input: "bash\x00",
			want:  "bash",
		},
		{
			name:  "empty",
			input: "",
			want:  "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := readCmdlineFromReader(strings.NewReader(tt.input))
			if err != nil {
				t.Errorf("readCmdlineFromReader() unexpected error: %v", err)
				return
			}
			if got != tt.want {
				t.Errorf("readCmdlineFromReader() = %q, want %q", got, tt.want)
			}
		})
	}
}

// ──────────────────────────────────────────────
// Unit: scanOnceFromDir with /proc fixture
// ──────────────────────────────────────────────

func TestScanOnceFromDir(t *testing.T) {
	// Create a temp /proc fixture
	dir := t.TempDir()

	procDirs := map[int]struct {
		ppid    int
		cmdline string
	}{
		// Orphan pi process (PPid=1, cmdline contains pi)
		100: {ppid: 1, cmdline: "/usr/bin/pi\x00--approve\x00"},
		// Orphan pi process with different args
		101: {ppid: 1, cmdline: "node\x00/usr/local/bin/pi.js\x00"},
		// Non-orphan pi (PPid != 1)
		200: {ppid: 42, cmdline: "/usr/bin/pi\x00--approve\x00"},
		// Non-pi process with PPid=1
		300: {ppid: 1, cmdline: "nginx\x00"},
		// Non-pi process with PPid != 1
		301: {ppid: 42, cmdline: "bash\x00"},
		// Another orphan pi
		102: {ppid: 1, cmdline: "/usr/bin/pi\x00"},
	}

	for pid, info := range procDirs {
		pidDir := filepath.Join(dir, itoa(pid))
		if err := os.MkdirAll(pidDir, 0755); err != nil {
			t.Fatal(err)
		}
		// Write stat file
		statContent := formatStat(pid, info.ppid)
		if err := os.WriteFile(filepath.Join(pidDir, "stat"), []byte(statContent), 0644); err != nil {
			t.Fatal(err)
		}
		// Write cmdline file
		if err := os.WriteFile(filepath.Join(pidDir, "cmdline"), []byte(info.cmdline), 0644); err != nil {
			t.Fatal(err)
		}
	}

	orphans, err := scanOnceFromDir(dir, "pi")
	if err != nil {
		t.Fatalf("scanOnceFromDir() unexpected error: %v", err)
	}

	// We expect PIDs 100, 101, 102 (orphan pi)
	want := map[int]bool{100: true, 101: true, 102: true}
	if len(orphans) != len(want) {
		t.Errorf("scanOnceFromDir() returned %d orphans: %v, want %d", len(orphans), orphans, len(want))
	}
	for _, pid := range orphans {
		if !want[pid] {
			t.Errorf("unexpected orphan PID %d in results", pid)
		}
		delete(want, pid)
	}
	for pid := range want {
		t.Errorf("expected orphan PID %d not found", pid)
	}
}

func TestScanOnceFromDir_UnreadableCmdline(t *testing.T) {
	dir := t.TempDir()

	// Create a proc dir without a cmdline file (simulating race-exited)
	pidDir := filepath.Join(dir, "100")
	if err := os.MkdirAll(pidDir, 0755); err != nil {
		t.Fatal(err)
	}
	// Write only stat, no cmdline
	if err := os.WriteFile(filepath.Join(pidDir, "stat"), []byte("100 (pi) S 1 100 100 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 123 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"), 0644); err != nil {
		t.Fatal(err)
	}

	// Also create a valid orphan to ensure scanning continues
	pidDir2 := filepath.Join(dir, "101")
	if err := os.MkdirAll(pidDir2, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pidDir2, "stat"), []byte("101 (pi) S 1 101 101 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 456 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pidDir2, "cmdline"), []byte("/usr/bin/pi\x00--approve\x00"), 0644); err != nil {
		t.Fatal(err)
	}

	orphans, err := scanOnceFromDir(dir, "pi")
	if err != nil {
		t.Fatalf("scanOnceFromDir() unexpected error: %v", err)
	}

	if len(orphans) != 1 || orphans[0] != 101 {
		t.Errorf("scanOnceFromDir() = %v, want [101]", orphans)
	}
}

func TestScanOnceFromDir_Empty(t *testing.T) {
	dir := t.TempDir()

	// Create a non-matching process
	pidDir := filepath.Join(dir, "100")
	if err := os.MkdirAll(pidDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pidDir, "stat"), []byte("100 (nginx) S 1 100 100 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 456 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pidDir, "cmdline"), []byte("nginx\x00"), 0644); err != nil {
		t.Fatal(err)
	}

	orphans, err := scanOnceFromDir(dir, "pi")
	if err != nil {
		t.Fatalf("scanOnceFromDir() unexpected error: %v", err)
	}
	if len(orphans) != 0 {
		t.Errorf("scanOnceFromDir() = %v, want empty", orphans)
	}
}

func TestScanOnceFromDir_CustomPidName(t *testing.T) {
	dir := t.TempDir()

	procDirs := map[int]struct {
		ppid    int
		cmdline string
	}{
		100: {ppid: 1, cmdline: "/usr/local/bin/my-service\x00--daemon\x00"},
		101: {ppid: 1, cmdline: "nginx\x00"},
	}

	for pid, info := range procDirs {
		pidDir := filepath.Join(dir, itoa(pid))
		if err := os.MkdirAll(pidDir, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(pidDir, "stat"), []byte(formatStat(pid, info.ppid)), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(pidDir, "cmdline"), []byte(info.cmdline), 0644); err != nil {
			t.Fatal(err)
		}
	}

	orphans, err := scanOnceFromDir(dir, "my-service")
	if err != nil {
		t.Fatalf("scanOnceFromDir() unexpected error: %v", err)
	}

	if len(orphans) != 1 || orphans[0] != 100 {
		t.Errorf("scanOnceFromDir() = %v, want [100]", orphans)
	}
}

// ──────────────────────────────────────────────
// Unit: escalate (uses real subprocess)
// ──────────────────────────────────────────────

func TestEscalate_AlreadyDead(t *testing.T) {
	var buf bytes.Buffer
	logger := log.New(&buf, "", 0)

	// PID that definitely doesn't exist
	got := escalate(999999999, false, logger)
	if got {
		t.Errorf("escalate() for dead PID = true, want false")
	}
}

func TestEscalate_ExitsDuringGrace(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping subprocess test in short mode")
	}

	var buf bytes.Buffer
	logger := log.New(&buf, "", 0)

	// Start a short-lived process that exits quickly
	proc, err := os.StartProcess("/bin/sleep", []string{"sleep", "0.05"}, &os.ProcAttr{})
	if err != nil {
		t.Fatalf("start sleep: %v", err)
	}

	got := escalate(proc.Pid, false, logger)
	// Process should exit before grace — we still get "success" meaning
	// we attempted cleanup. It exits during grace period, so escalate
	// reports true.
	if !got {
		t.Errorf("escalate() for exiting process = false, want true")
	}
}

func TestEscalate_DryRun(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping subprocess test in short mode")
	}

	var buf bytes.Buffer
	logger := log.New(&buf, "", 0)

	proc, err := os.StartProcess("/bin/sleep", []string{"sleep", "5"}, &os.ProcAttr{})
	if err != nil {
		t.Fatalf("start sleep: %v", err)
	}
	defer proc.Kill()

	got := escalate(proc.Pid, true, logger)
	if got {
		t.Errorf("escalate() with dry-run = true, want false")
	}

	if !strings.Contains(buf.String(), "dry-run") {
		t.Errorf("dry-run log missing, got: %s", buf.String())
	}
}

func TestEscalate_SIGKILLAfterGrace(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping subprocess test in short mode")
	}

	var buf bytes.Buffer
	logger := log.New(&buf, "", 0)

	// Start a process that ignores SIGTERM (Docker's tini behavior)
	// We use a subshell that traps SIGTERM and sleeps instead of dying
	proc, err := os.StartProcess("/bin/bash", []string{"bash", "-c", "trap '' TERM; sleep 30"}, &os.ProcAttr{})
	if err != nil {
		t.Fatalf("start bash: %v", err)
	}
	defer proc.Kill()

	// escalate has 5s grace period — should SIGKILL after
	got := escalate(proc.Pid, false, logger)
	if !got {
		t.Errorf("escalate() for SIGTERM-ignoring process = false, want true")
	}

	// Verify process is dead
	alive := syscall.Kill(proc.Pid, 0)
	if alive == nil {
		t.Errorf("process %d still alive after escalate", proc.Pid)
	}

	if !strings.Contains(buf.String(), "SIGKILL") {
		t.Errorf("SIGKILL log missing, got: %s", buf.String())
	}
}

// ──────────────────────────────────────────────
// Unit: reapZombies
// ──────────────────────────────────────────────

func TestReapZombies_NoPanic(t *testing.T) {
	// reapZombies should not panic regardless of state
	reapZombies()
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

func itoa(i int) string {
	return strconv.Itoa(i)
}

// formatStat creates a minimal /proc/pid/stat line for testing.
func formatStat(pid, ppid int) string {
	return fmt.Sprintf("%d (pi) R %d %d %d 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 123 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0", pid, ppid, pid, pid)
}
