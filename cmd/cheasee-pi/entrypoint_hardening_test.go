package main

import (
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 6: CHEASEEPI_CPUS command injection hardening (#1671)
// ──────────────────────────────────────────────

// ── Phase 6a: structural hardening ────────────────────────────────

func TestEntrypoint_NoAwkInterpolation(t *testing.T) {
	content := readEntrypoint(t)
	// The vulnerable pattern: env vars interpolated into a double-quoted awk
	// program string (shell/awk metacharacters execute as root).
	for _, bad := range []string{`awk "BEGIN`, `$CHEASEEPI_CPUS * `} {
		if strings.Contains(content, bad) {
			t.Errorf("entrypoint must not interpolate env vars into an awk program string (%q)", bad)
		}
	}
	if !strings.Contains(content, "awk -v cpus=") {
		t.Error("entrypoint must pass CHEASEEPI_CPUS to awk via -v cpus= (never as program text)")
	}
}

func TestEntrypoint_AwkProgramConstant(t *testing.T) {
	content := readEntrypoint(t)
	// The awk program must be a single-quoted constant with no env-var
	// references — -v assignments are the only channel for values.
	if !strings.Contains(content, `'BEGIN {printf "%d", cpus * period}'`) {
		t.Errorf("awk program must be the single-quoted constant 'BEGIN {printf \"%%d\", cpus * period}'")
	}
	if !strings.Contains(content, `-v period="$PERIOD"`) {
		t.Error("awk invocation must pass the period via -v as well")
	}
	if !strings.Contains(content, `printf "%d"`) {
		t.Error("awk printf format must be quoted (mawk rejects the unquoted form for all inputs)")
	}
}

func TestEntrypoint_CpusValidationRegex(t *testing.T) {
	content := readEntrypoint(t)
	const re = `^[0-9]+(\.[0-9]+)?$`
	if !strings.Contains(content, re) {
		t.Errorf("entrypoint must validate CHEASEEPI_CPUS with anchored regex %s (ERE, unquoted, full match)", re)
	}
	reIdx := strings.Index(content, re)
	awkIdx := strings.Index(content, "awk -v cpus=")
	if reIdx > awkIdx {
		t.Error("validation regex must be evaluated before any awk invocation")
	}
}

func TestEntrypoint_CpusInvalidWarningNonFatal(t *testing.T) {
	content := readEntrypoint(t)
	// Invalid-input warning must name CHEASEEPI_CPUS (distinguishable from the
	// cgroup-write-failure warning) and must be non-fatal: early-return, no exit.
	if !strings.Contains(content, "Warning: CHEASEEPI_CPUS=") {
		t.Error("invalid CHEASEEPI_CPUS must emit a warning that names the variable")
	}
	body := extractFunc(t, "apply_cpu_limit")
	if strings.Contains(body, "exit") {
		t.Error("apply_cpu_limit must never exit (invalid CHEASEEPI_CPUS is non-fatal)")
	}
	// After the warning the very next statement must be the non-fatal return 0
	// (the other return 0 — the empty-value skip — legitimately precedes it).
	warnIdx := strings.Index(body, "Warning: CHEASEEPI_CPUS=")
	if warnIdx < 0 {
		t.Error("invalid CHEASEEPI_CPUS must emit a warning that names the variable")
		return
	}
	afterWarn := body[warnIdx:]
	retIdx := strings.Index(afterWarn, "return 0")
	fiIdx := strings.Index(afterWarn, "\n    fi")
	if retIdx < 0 || retIdx > fiIdx {
		t.Error("the CHEASEEPI_CPUS warning must be followed by a non-fatal return 0")
	}
}

func TestEntrypoint_CpuLimitOrderingAndPeriod(t *testing.T) {
	content := readEntrypoint(t)
	defIdx := strings.Index(content, "apply_cpu_limit() {")
	invIdx := strings.Index(content, "\napply_cpu_limit\n")
	execIdx := strings.Index(content, `exec gosu agentuser "$@"`)
	if defIdx < 0 || invIdx < 0 || execIdx < 0 {
		t.Fatal("expected apply_cpu_limit definition/invocation and final exec gosu agentuser")
	}
	if defIdx > execIdx || invIdx > execIdx {
		t.Error("the CPU limit block must run before the final exec gosu agentuser")
	}
	if !strings.Contains(content, "PERIOD=100000") {
		t.Error("PERIOD=100000 must be retained")
	}
}
