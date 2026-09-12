package main

import (
	"fmt"
	"os"
	"path/filepath"
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

func TestEntrypoint_RemapUidGidDefinedWithNumericGuard(t *testing.T) {
	content := readEntrypoint(t)
	if !strings.Contains(content, "remap_uid_gid() {") {
		t.Error("entrypoint must define remap_uid_gid()")
	}
	if !strings.Contains(content, "\nremap_uid_gid\n") {
		t.Error("entrypoint must invoke remap_uid_gid()")
	}
	// Numeric guard for both vars, warning names the variable, non-fatal.
	if !strings.Contains(content, `[[ "$HOST_UID" =~ ^[0-9]+$ ]]`) {
		t.Error("remap_uid_gid must guard HOST_UID with an anchored numeric regex")
	}
	if !strings.Contains(content, `[[ "$HOST_GID" =~ ^[0-9]+$ ]]`) {
		t.Error("remap_uid_gid must guard HOST_GID with an anchored numeric regex")
	}
	if !strings.Contains(content, "Warning: HOST_UID=") || !strings.Contains(content, "Warning: HOST_GID=") {
		t.Error("non-numeric HOST_UID/HOST_GID must warn naming the variable")
	}
	// Workspace auto-detect block retained unchanged, ordered before the remap.
	for _, want := range []string{"stat -c '%u' /workspaces/main", "Auto-detected HOST_UID=", "Auto-detected HOST_GID="} {
		if !strings.Contains(content, want) {
			t.Errorf("workspace auto-detect block must be retained (%q)", want)
		}
	}
}

// ── Phase 6b: apply_cpu_limit() entity behavior ───────────────────

func TestEntrypoint_ApplyCpuLimit_ValidValues(t *testing.T) {
	// Characterization of the corrected intended behavior: numeric values map
	// cpus*100000 into the quota, written as "<quota> 100000" to cpu.max.
	cases := map[string]string{
		"4.0":  "400000 100000",
		"2":    "200000 100000",
		"1":    "100000 100000",
		"0.25": "25000 100000",
		"0.1":  "10000 100000",
		"16.0": "1600000 100000",
	}
	for value, want := range cases {
		t.Run(value, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(dir, "cpu.max")
			body := fmt.Sprintf(`
cd %s
CHEASEEPI_CPUS=%s CGROUP_CPU_MAX=%s apply_cpu_limit
[ "$(cat %s)" = %s ] || { echo "unexpected content: $(cat %s)"; exit 1; }
echo OK
`, shq(dir), shq(value), shq(target), shq(target), shq(want), shq(target))
			out, err := runBashScript(t, funcScript(t, "apply_cpu_limit", body))
			assertOK(t, out, err, fmt.Sprintf("apply_cpu_limit(%q)", value))
		})
	}
}

func TestEntrypoint_ApplyCpuLimit_ZeroNoWrite(t *testing.T) {
	for _, value := range []string{"0", "0.0"} {
		t.Run(value, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(dir, "cpu.max")
			body := fmt.Sprintf(`
cd %s
CHEASEEPI_CPUS=%s CGROUP_CPU_MAX=%s apply_cpu_limit
[ ! -e %s ] || { echo "cpu.max written"; exit 1; }
echo OK
`, shq(dir), shq(value), shq(target), shq(target))
			out, err := runBashScript(t, funcScript(t, "apply_cpu_limit", body))
			assertOK(t, out, err, fmt.Sprintf("apply_cpu_limit(%q)", value))
		})
	}
}

func TestEntrypoint_ApplyCpuLimit_EmptySilentSkip(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "cpu.max")
	body := fmt.Sprintf(`
cd %s
unset CHEASEEPI_CPUS
out1=$(CGROUP_CPU_MAX=%s apply_cpu_limit)
out2=$(CHEASEEPI_CPUS='' CGROUP_CPU_MAX=%s apply_cpu_limit)
[ -z "$out1" ] || { echo "unset produced output: $out1"; exit 1; }
[ -z "$out2" ] || { echo "empty produced output: $out2"; exit 1; }
[ ! -e %s ] || { echo "cpu.max written"; exit 1; }
echo OK
`, shq(dir), shq(target), shq(target), shq(target))
	out, err := runBashScript(t, funcScript(t, "apply_cpu_limit", body))
	assertOK(t, out, err, "empty/unset apply_cpu_limit")
}

func TestEntrypoint_ApplyCpuLimit_HostileRejected(t *testing.T) {
	// Every hostile value must warn (naming CHEASEEPI_CPUS), write nothing,
	// create no file, and return 0 — never reach awk, never execute.
	hostile := []string{
		`0.5; system("touch $tmp")`,
		"0.5; touch $tmp; ",
		"$(touch $tmp)",
		"4; touch $tmp",
		"abc",
		"4.0.1",
		"-2",
		"1e6",
		".5",
		"5.",
		"4,0",
		" 4.0",
		"4.0 ",
	}
	for _, value := range hostile {
		t.Run(value, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(dir, "cpu.max")
			body := fmt.Sprintf(`
cd %s
tmp="$PWD/injected"
out=$(CHEASEEPI_CPUS=%s CGROUP_CPU_MAX=%s apply_cpu_limit)
case "$out" in
  *"Warning: CHEASEEPI_CPUS="*) ;;
  *) echo "no CHEASEEPI_CPUS warning: $out"; exit 1 ;;
esac
[ ! -e "$tmp" ] || { echo "injection executed"; exit 1; }
[ ! -e %s ] || { echo "cpu.max written"; exit 1; }
echo OK
`, shq(dir), shq(value), shq(target), shq(target))
			out, err := runBashScript(t, funcScript(t, "apply_cpu_limit", body))
			assertOK(t, out, err, fmt.Sprintf("apply_cpu_limit(%q)", value))
		})
	}
}

func TestEntrypoint_ApplyCpuLimit_AwkFailureWarns(t *testing.T) {
	// awk failing (never hostile input — regex-validated above, but e.g. float
	// overflow on a huge valid number) must warn, write nothing, and return 0 —
	// NOT silently return success with cpu.max unchanged (audit: visible error
	// handling). Stub awk via PATH to force the failure deterministically.
	dir := t.TempDir()
	binDir := t.TempDir()
	stubBin(t, binDir, "awk", filepath.Join(t.TempDir(), "marker"), "exit 1")
	target := filepath.Join(dir, "cpu.max")
	body := fmt.Sprintf(`
cd %s
out=$(PATH=%s CHEASEEPI_CPUS='4.0' CGROUP_CPU_MAX=%s apply_cpu_limit)
case "$out" in
  *"Warning: could not compute CPU quota"*) ;;
  *) echo "no CPU-quota warning: $out"; exit 1 ;;
esac
[ ! -e %s ] || { echo "cpu.max written"; exit 1; }
echo OK
`, shq(dir), shq(binDir+":"+os.Getenv("PATH")), shq(target), shq(target))
	out, err := runBashScript(t, funcScript(t, "apply_cpu_limit", body))
	assertOK(t, out, err, "apply_cpu_limit awk-failure path")
}

func TestEntrypoint_ApplyCpuLimit_WriteFailureWarns(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "no-such-dir", "cpu.max")
	body := fmt.Sprintf(`
cd %s
out=$(CHEASEEPI_CPUS='4.0' CGROUP_CPU_MAX=%s apply_cpu_limit)
case "$out" in
  *"could not write CPU limit"*) ;;
  *) echo "no cgroup warning: $out"; exit 1 ;;
esac
echo OK
`, shq(dir), shq(target))
	out, err := runBashScript(t, funcScript(t, "apply_cpu_limit", body))
	assertOK(t, out, err, "apply_cpu_limit write-failure path")
}

func TestEntrypoint_ApplyCpuLimit_Idempotent(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "cpu.max")
	body := fmt.Sprintf(`
cd %s
CHEASEEPI_CPUS='4.0' CGROUP_CPU_MAX=%s apply_cpu_limit
CHEASEEPI_CPUS='4.0' CGROUP_CPU_MAX=%s apply_cpu_limit
[ "$(cat %s)" = '400000 100000' ] || { echo "unexpected: $(cat %s)"; exit 1; }
echo OK
`, shq(dir), shq(target), shq(target), shq(target), shq(target))
	out, err := runBashScript(t, funcScript(t, "apply_cpu_limit", body))
	assertOK(t, out, err, "apply_cpu_limit re-run")
}

// ── Phase 6c: remap_uid_gid() numeric guard ───────────────────────

func TestEntrypoint_RemapUidGid_NonNumericSkipped(t *testing.T) {
	// Both HOST_UID and HOST_GID share the same contract: non-numeric value →
	// warning naming the variable, no usermod/groupmod invocation, no
	// injection, return 0 (would abort under set -e today).
	binDir, marker := remapStubs(t)
	cases := []struct{ varName, warning string }{
		{"HOST_UID", "Warning: HOST_UID="},
		{"HOST_GID", "Warning: HOST_GID="},
	}
	hostile := []string{"abc", "-1", "4.5", "1000; touch $tmp; "}
	for _, c := range cases {
		for _, value := range hostile {
			t.Run(c.varName+"/"+value, func(t *testing.T) {
				dir := t.TempDir()
				body := fmt.Sprintf(`
cd %s
unset HOST_UID HOST_GID
tmp="$PWD/injected"
out=$(PATH=%s %s=%s remap_uid_gid)
case "$out" in
  *"%s"*) ;;
  *) echo "no %s warning: $out"; exit 1 ;;
esac
[ ! -e %s ] || { echo "usermod/groupmod invoked"; exit 1; }
[ ! -e "$tmp" ] || { echo "injection executed"; exit 1; }
echo OK
`, shq(dir), shq(binDir+":"+os.Getenv("PATH")), c.varName, shq(value), c.warning, c.varName, shq(marker))
				out, err := runBashScript(t, funcScript(t, "remap_uid_gid", body))
				assertOK(t, out, err, fmt.Sprintf("remap_uid_gid(%s=%q)", c.varName, value))
			})
		}
	}
}

func TestEntrypoint_RemapUidGid_NumericProceeds(t *testing.T) {
	binDir, marker := remapStubs(t)
	body := fmt.Sprintf(`
cd %s
unset HOST_UID HOST_GID
PATH=%s HOST_UID=1234 HOST_GID=1234 remap_uid_gid
grep -q -- "-u 1234" %s || { echo "usermod -u 1234 not recorded"; exit 1; }
grep -q -- "-g 1234" %s || { echo "usermod -g 1234 not recorded"; exit 1; }
grep -q "groupmod -g 1234" %s || { echo "groupmod -g 1234 not recorded"; exit 1; }
echo OK
`, shq(t.TempDir()), shq(binDir+":"+os.Getenv("PATH")), shq(marker), shq(marker), shq(marker))
	out, err := runBashScript(t, funcScript(t, "remap_uid_gid", body))
	assertOK(t, out, err, "remap_uid_gid(1234/1234)")
}
