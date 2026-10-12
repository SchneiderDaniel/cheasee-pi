package main

import (
	"strings"
	"testing"
)

// Orphan session scan/kill coverage: the orphanScanBash script text,
// scanOrphans orchestration and killSessionByMarker. Moved verbatim
// from up_test.go.
// ──────────────────────────────────────────────

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
	// The direct-exec indirection: a `/usr/bin/pi` argv[0] still matches.
	if !strings.Contains(orphanScanBash, `/usr/bin/pi`) {
		t.Error("orphanScanBash missing the direct /usr/bin/pi argv match")
	}
	// A shebang-launched pi never has argv[0]=pi — the tokenizer must key on the
	// package path and the session flag pair instead.
	if strings.Contains(orphanScanBash, "cmdline=$(") {
		t.Error("orphanScanBash must tokenize argv, not prefix-match the joined cmdline")
	}
}

func TestOrphanScanBash_matchesShebangPiArgvTokens(t *testing.T) {
	for _, want := range []string{"pi_is_session", "pi-coding-agent", "--session", "--session-id", `read -r -d ''`} {
		if !strings.Contains(orphanScanBash, want) {
			t.Errorf("orphanScanBash must match shebang pi argv tokens; missing %q", want)
		}
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

func TestOrphanScanBash_ageReaperGatedByEnv(t *testing.T) {
	if !strings.Contains(orphanScanBash, "CHEASEE_MAX_AGE_MIN") {
		t.Error("orphanScanBash should gate the age reaper on CHEASEE_MAX_AGE_MIN")
	}
	if !strings.Contains(orphanScanBash, "/proc/uptime") {
		t.Error("orphanScanBash should compute session age from /proc/uptime")
	}
	if !strings.Contains(orphanScanBash, "awk '{print $22}'") {
		t.Error("orphanScanBash should read start time (stat field 22) for age")
	}
	if !strings.Contains(orphanScanBash, "6000") {
		t.Error("orphanScanBash should convert ticks to minutes (6000 ticks/min)")
	}
}
