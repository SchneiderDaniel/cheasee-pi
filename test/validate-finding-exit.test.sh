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
[ -n "${PI_STUB_MARKER:-}" ] && : >"$PI_STUB_MARKER"
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

# Stub for the deterministic stage, selected through FAST_PATH_CMD. It exists
# so the ordering contract is exercised without a real repository.
cat >"$stub_dir/fast-path-stub" <<'STUB'
#!/usr/bin/env bash
[ -n "${FAST_PATH_MARKER:-}" ] && : >"$FAST_PATH_MARKER"
case "${FAST_PATH_STUB_MODE:-defer}" in
  invalid)
    echo "VERDICT: INVALID"
    echo "REASON: stubbed deterministic rule"
    echo "EVIDENCE: src/a.ts:1"
    echo "RULE: ambient-type-only-member (known-fp row 11)"
    exit 1 ;;
  crash) echo "RangeError: fast path exploded" >&2; exit 4 ;;
  *)     exit 10 ;;
esac
STUB
chmod +x "$stub_dir/fast-path-stub"
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

# ── Deterministic-first ordering (the fast path runs before the subagent) ──
FP_STUB="$stub_dir/fast-path-stub"
pi_marker="$stub_dir/pi-ran"
fp_marker="$stub_dir/fast-path-ran"

# run_fp <fast-path-mode> <pi-mode> -> RUN_STATUS/RUN_OUT/RUN_ERR + markers.
# The fast path is the stub, so the ordering is pinned without a repository.
run_fp() {
  local out err
  out="$(mktemp)"; err="$(mktemp)"
  rm -f "$pi_marker" "$fp_marker"
  env FAST_PATH_CMD="$FP_STUB" FAST_PATH_STUB_MODE="$1" FAST_PATH_MARKER="$fp_marker" \
      PI_STUB_MODE="$2" PI_STUB_MARKER="$pi_marker" \
      "$SCRIPT" "$finding" "$REPO_ROOT" >"$out" 2>"$err"
  RUN_STATUS=$?
  RUN_OUT="$(cat "$out")"
  RUN_ERR="$(cat "$err")"
  rm -f "$out" "$err"
}

# A fast-path INVALID short-circuits: verdict printed, exit 1, no subagent.
run_fp invalid valid
[ "$RUN_STATUS" = 1 ] || fail_msg "fast-path INVALID should exit 1 (got $RUN_STATUS)"
case "$RUN_OUT" in *"VERDICT: INVALID"*) ;; *) fail_msg "fast-path INVALID must print its verdict" ;; esac
case "$RUN_OUT" in *"RULE: "*"(known-fp row "*) ;; *) fail_msg "fast-path verdict must carry the RULE provenance" ;; esac
[ -f "$fp_marker" ] || fail_msg "the fast path must run before the subagent"
[ -f "$pi_marker" ] && fail_msg "a fast-path INVALID must not spawn the subagent"

# A deferral falls through: the subagent's verdict is authoritative.
run_fp defer valid
[ "$RUN_STATUS" = 0 ] || fail_msg "a deferred finding must reach the subagent (got $RUN_STATUS)"
[ -f "$pi_marker" ] || fail_msg "a deferred finding must spawn the subagent"
case "$RUN_OUT" in *"VERDICT: VALID"*) ;; *) fail_msg "the subagent verdict must be used after a deferral" ;; esac

# A fast-path crash is not a verdict: fail open to the subagent.
run_fp crash valid
[ "$RUN_STATUS" = 0 ] || fail_msg "a fast-path crash must fail open (got $RUN_STATUS)"
[ -f "$pi_marker" ] || fail_msg "a fast-path crash must fall through to the subagent"
case "$RUN_ERR" in *"fast path exploded"*) ;; *) fail_msg "a fast-path crash must be disclosed on stderr" ;; esac

# Usage errors are decided before the fast path and never invoke it.
rm -f "$fp_marker"
env FAST_PATH_CMD="$FP_STUB" FAST_PATH_STUB_MODE=invalid FAST_PATH_MARKER="$fp_marker" \
  "$SCRIPT" /no/such/finding.md "$REPO_ROOT" >/dev/null 2>&1
[ "$?" = 2 ] || fail_msg "missing finding must still exit 2"
[ -f "$fp_marker" ] && fail_msg "the fast path must not run for a missing finding file"

# ── Operator journey: the documented batched Step 3 loop ──
# Persona: the skill operator running Step 3 over a mixed finding directory.
# The outcome differs per file, and nothing is dropped or left verdict-less.
journey_ok=1
journey_dir="$(mktemp -d)"
repo_mini="$(mktemp -d)"
mkdir -p "$repo_mini/.pi/extensions/ripgrep-search" "$repo_mini/src"
printf 'spawn("git", ["status"]);\n' >"$repo_mini/src/run.ts"
printf 'declare module "x" {\n  function ambient_member(): void;\n}\n' >"$repo_mini/src/a.ts"

# Stubbed tools for the journey: rg lists/answers, ast-grep reports the
# bodyless ambient declaration of the symbol the fall-through finding names.
journey_bin="$(mktemp -d)"
cat >"$journey_bin/rg" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *--files-with-matches*) echo "src/a.ts" ;;
  *) echo "src/a.ts:2:  function ambient_member(): void;" ;;
esac
exit 0
STUB
cat >"$journey_bin/ast-grep" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' '{"text":"function ambient_member(): void;","range":{"start":{"line":1}},"file":"src/a.ts"}'
exit 0
STUB
chmod +x "$journey_bin/rg" "$journey_bin/ast-grep"

write_finding() {  # write_finding <file> <kind> <title> <targets> <files>
  printf '# CodeFlow finding (%s)\n\n**Kind:** %s\n**Issue type:** bug\n**Disposition:** file-bug\n**Title:** %s\n**Id:** %s\n**Targets:** %s\n**Files:** %s\n' \
    "$2" "$2" "$3" "$2:0" "$4" "$5" >"$1"
}

write_finding "$journey_dir/1-argv.md" security "MEDIUM: Command Execution" '`src/run.ts`' "src/run.ts"
write_finding "$journey_dir/2-ambient.md" dead-code "ambient_member()" '`src/a.ts`' "src/a.ts"
write_finding "$journey_dir/3-suggestion.md" suggestion "extract a shared helper" "(no file — derived signal)" "(none)"
write_finding "$journey_dir/4-defer.md" security "HIGH: Hardcoded Secret" '`src/run.ts`' "src/run.ts"

for f in "$journey_dir"/*.md; do
  FAST_PATH_CMD="" PI_STUB_MODE=valid PI_STUB_MARKER="$stub_dir/journey-pi" \
    PATH="$journey_bin:$stub_dir:$PATH" \
    "$SCRIPT" "$f" "$repo_mini" >"${f%.md}.verdict" 2>/dev/null </dev/null
done

invalid_n=0; deferred_m=0
for f in "$journey_dir"/*.verdict; do
  if grep -q '^VERDICT: INVALID$' "$f"; then
    invalid_n=$((invalid_n + 1))
    grep -q '^RULE: ' "$f" || { echo "FAIL: journey INVALID without RULE provenance: $f" >&2; journey_ok=0; }
  elif grep -q '^VERDICT: ' "$f"; then
    deferred_m=$((deferred_m + 1))
  else
    echo "FAIL: journey candidate left without a verdict: $f" >&2
    journey_ok=0
  fi
done
[ "$((invalid_n + deferred_m))" = 4 ] || { echo "FAIL: journey n + m must equal the candidate count (got $invalid_n + $deferred_m)" >&2; journey_ok=0; }
[ "$invalid_n" -ge 2 ] || { echo "FAIL: journey must resolve the ambient/argv/suggestion shapes deterministically (got $invalid_n)" >&2; journey_ok=0; }
grep -q '^VERDICT: INVALID$' "$journey_dir/2-ambient.verdict" || { echo "FAIL: the ambient shape must be resolved by the fast path" >&2; journey_ok=0; }
grep -q '^RULE: ambient-type-only-member' "$journey_dir/2-ambient.verdict" || { echo "FAIL: the ambient verdict must name its rule" >&2; journey_ok=0; }
grep -q '^VERDICT: INVALID$' "$journey_dir/3-suggestion.verdict" || { echo "FAIL: the suggestion shape must be resolved by the fast path" >&2; journey_ok=0; }
grep -q '^VERDICT: VALID$' "$journey_dir/4-defer.verdict" || { echo "FAIL: the deferred finding must carry the subagent verdict" >&2; journey_ok=0; }
grep -rq 'VERDICT: VALID' "$journey_dir/1-argv.verdict" "$journey_dir/2-ambient.verdict" "$journey_dir/3-suggestion.verdict" && { echo "FAIL: no fast-path verdict may be VALID" >&2; journey_ok=0; }
[ "$journey_ok" = 1 ] || fail=1
rm -rf "$journey_dir" "$journey_bin" "$repo_mini"

if [ "$fail" = 0 ]; then
  echo "validate-finding exit-code contract OK"
fi
exit "$fail"
