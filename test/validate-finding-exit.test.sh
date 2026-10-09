#!/usr/bin/env bash
# Tests for .pi/skills/audit-codeflow-analysis/scripts/validate-finding.sh
# exit-code contract (issue #1976): crash (4) is distinct from a verdict-less
# run (3) and from an agent usage mistake (2).
#
# Run with:
#   bash test/validate-finding-exit.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
SCRIPT="$REPO_ROOT/.pi/skills/audit-codeflow-analysis/scripts/validate-finding.sh"

fail=0
fail_msg() { echo "FAIL: $1" >&2; fail=1; }

# Controlled `pi` stub, first on PATH. Ignores the validator's argv and prints
# whatever PI_STUB_MODE asks for.
stub_dir="$(mktemp -d)"
trap 'rm -rf "$stub_dir"' EXIT
cat >"$stub_dir/pi" <<'STUB'
#!/usr/bin/env bash
case "${PI_STUB_MODE:-}" in
  valid)     echo "VERDICT: VALID"; echo "EVIDENCE: report.ts:1"; exit 0 ;;
  invalid)   echo "VERDICT: INVALID"; echo "REASON: comment only, no SQL"; exit 0 ;;
  neverdict) echo "I read the code and have nothing to say."; exit 0 ;;
  crash)     echo "RangeError: Invalid string length" >&2; exit 1 ;;
  timeout)   exit 124 ;;
  *)         exit 0 ;;
esac
STUB
chmod +x "$stub_dir/pi"
export PATH="$stub_dir:$PATH"

finding="$(mktemp)"
printf '# CodeFlow finding (security)\n\n**Title:** HIGH: Hardcoded Secret\n' >"$finding"
trap 'rm -rf "$stub_dir"; rm -f "$finding"' EXIT

# run <mode> [finding] [repo-root] -> sets RUN_STATUS/RUN_OUT/RUN_ERR
run_case() {
  local mode="$1" f="${2:-$finding}" root="${3:-$REPO_ROOT}"
  local out err
  out="$(mktemp)"; err="$(mktemp)"
  PI_STUB_MODE="$mode" "$SCRIPT" "$f" "$root" >"$out" 2>"$err"
  RUN_STATUS=$?
  RUN_OUT="$(cat "$out")"
  RUN_ERR="$(cat "$err")"
  rm -f "$out" "$err"
}

run_case valid
[ "$RUN_STATUS" = 0 ] || fail_msg "VERDICT: VALID should exit 0 (got $RUN_STATUS)"
case "$RUN_OUT" in *"VERDICT: VALID"*) ;; *) fail_msg "valid stdout missing verdict" ;; esac

run_case invalid
[ "$RUN_STATUS" = 1 ] || fail_msg "VERDICT: INVALID should exit 1 (got $RUN_STATUS)"

run_case neverdict
[ "$RUN_STATUS" = 3 ] || fail_msg "verdict-less run should exit 3 (got $RUN_STATUS)"
case "$RUN_ERR" in *"no VERDICT line"*) ;; *) fail_msg "exit 3 must say no VERDICT line" ;; esac

run_case crash
[ "$RUN_STATUS" = 4 ] || fail_msg "crash should exit 4 (got $RUN_STATUS)"
case "$RUN_ERR" in *"RangeError: Invalid string length"*) ;; *) fail_msg "exit 4 must preserve the validator output" ;; esac
case "$RUN_ERR" in *"subagent failed"*) ;; *) fail_msg "exit 4 must name the crash" ;; esac
[ -z "$RUN_OUT" ] || fail_msg "exit 4 must not print a fabricated verdict on stdout"

run_case timeout
[ "$RUN_STATUS" = 4 ] || fail_msg "timeout should exit 4 (got $RUN_STATUS)"

# Usage errors: missing finding file and a bad repo root both exit 2 and print
# nothing to stdout.
run_case valid /no/such/finding.md
[ "$RUN_STATUS" = 2 ] || fail_msg "missing finding should exit 2 (got $RUN_STATUS)"
[ -z "$RUN_OUT" ] || fail_msg "missing finding must not write stdout"

run_case valid "$finding" /tmp
[ "$RUN_STATUS" = 2 ] || fail_msg "bad repo root should exit 2 (got $RUN_STATUS)"
[ -z "$RUN_OUT" ] || fail_msg "bad repo root must not write stdout"

if [ "$fail" = 0 ]; then
  echo "validate-finding exit-code contract OK"
fi
exit "$fail"
