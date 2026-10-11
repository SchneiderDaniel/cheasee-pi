#!/usr/bin/env bash
# Verify one CodeFlow finding with a read-only pi subagent.
#
# Usage: validate-finding.sh <finding.md> [repo-root]
#        validate-finding.sh --self-test
#
# Two stages, in this order:
#   1. deterministic known-FP pre-filter (`scripts/fast-path.mts`, no LLM). It
#      can only ever return INVALID; exit 1 is the *only* short-circuit and its
#      stdout is printed verbatim. Every other outcome — defer, usage error,
#      crash, missing node/rg/ast-grep — falls through to stage 2.
#   2. the read-only pi subagent, unchanged.
#
# Prints the verdict block. Exit codes:
#   0  VERDICT: VALID (subagent only)
#   1  VERDICT: INVALID (pre-filter or subagent)
#   2  bad usage / missing file / bad repo root (agent mistake — fix the call)
#   3  the validator ran and printed no VERDICT line (unverified)
#   4  the validator crashed/timed out/could not be spawned (recovery — retry once)
#
# A crash is not an answer: `4` means no verdict was reached, so a single
# retry is recovery, not answer-shopping. A bare verdict-less run (`3`) already
# ran to completion, so it is disclosed unverified and never retried.

set -uo pipefail

parse_verdict() {
	awk '/^VERDICT:/ { print $2; exit }' <<<"$1"
}

# Verdict text that ran to completion -> exit code (0 VALID, 1 INVALID, 3 none).
map_verdict_exit() {
	case "$(parse_verdict "$1")" in
	VALID) echo 0 ;;
	INVALID) echo 1 ;;
	*) echo 3 ;;
	esac
}

# A finished subagent run -> exit code: crash status wins over the verdict text.
exit_for_run() {
	[ "$1" -ne 0 ] && { echo 4; return; }
	map_verdict_exit "$2"
}

if [ "${1:-}" = "--self-test" ]; then
	fail=0
	check() { [ "$(parse_verdict "$2")" = "$3" ] || { echo "FAIL: $1 (got '$(parse_verdict "$2")')" >&2; fail=1; }; }
	check "valid" "blah
VERDICT: VALID
EVIDENCE: a.ts:1" "VALID"
	check "invalid" "VERDICT: INVALID
REASON: nope" "INVALID"
	check "missing" "no verdict here" ""
	check_exit() { [ "$(exit_for_run "$2" "$3")" = "$4" ] || { echo "FAIL: $1 (got '$(exit_for_run "$2" "$3")')" >&2; fail=1; }; }
	check_exit "valid -> 0" "0" "VERDICT: VALID" "0"
	check_exit "invalid -> 1" "0" "VERDICT: INVALID" "1"
	check_exit "no verdict -> 3" "0" "ran fine, said nothing" "3"
	check_exit "crash -> 4" "1" "VERDICT: VALID" "4"
	check_exit "timeout -> 4" "124" "" "4"
	check_exit "spawn failure -> 4" "127" "" "4"
	[ "$fail" = 0 ] && echo "self-test OK"
	exit "$fail"
fi

finding="${1:-}"
if [ -z "$finding" ] || [ ! -f "$finding" ]; then
	echo "usage: $(basename "$0") <finding.md> [repo-root]" >&2
	exit 2
fi

repo_root="${2:-$(git rev-parse --show-toplevel 2>/dev/null)}"
if [ -z "$repo_root" ] || [ ! -d "$repo_root/.pi/extensions/ripgrep-search" ]; then
	echo "repo root not found (need <root>/.pi/extensions/ripgrep-search): '$repo_root'" >&2
	exit 2
fi
skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Stage 1: the deterministic known-FP pre-filter. `FAST_PATH_CMD` overrides the
# command (default preserved) so a test can stub the stage without touching the
# rules. Only exit 1 short-circuits; the rules cannot return VALID, so the LLM
# stays the sole source of a VALID verdict.
fast_path_out="$(mktemp)"
fast_path_err="$(mktemp)"
fast_path_status=0
if [ -n "${FAST_PATH_CMD:-}" ]; then
	# shellcheck disable=SC2086
	${FAST_PATH_CMD} "$finding" "$repo_root" >"$fast_path_out" 2>"$fast_path_err" || fast_path_status=$?
else
	node --experimental-strip-types "$skill_dir/scripts/fast-path.mts" "$finding" "$repo_root" \
		>"$fast_path_out" 2>"$fast_path_err" || fast_path_status=$?
fi
if [ "$fast_path_status" = 1 ] && grep -q '^VERDICT: INVALID$' "$fast_path_out"; then
	cat "$fast_path_out"
	rm -f "$fast_path_out" "$fast_path_err"
	exit 1
fi
# Anything else (defer 10, usage 2, a crash, a missing tool, an exit 1 without a
# verdict block) is not a verdict: disclose it and let stage 2 answer. Never a
# verdict-less exit.
if [ -s "$fast_path_err" ]; then
	cat "$fast_path_err" >&2
fi
rm -f "$fast_path_out" "$fast_path_err"

# Inherit the caller's model: without --model the subagent resolves the stored
# default, which can hit a different (unfunded) provider than this session.
model_args=()
[ -n "${PI_MODEL:-}" ] && model_args=(--model "${PI_PROVIDER:+$PI_PROVIDER/}$PI_MODEL")

verdict_file="$(mktemp)"
trap 'rm -f "$verdict_file"' EXIT INT TERM
run_status=0
timeout 600 pi -p \
	--no-extensions \
	--no-session \
	"${model_args[@]+"${model_args[@]}"}" \
	-e "$repo_root/.pi/extensions/ripgrep-search/index.ts" \
	-e "$repo_root/.pi/extensions/structural-analyzer/index.ts" \
	--tools read,ripgrep_search,structural_search \
	--no-skills --no-context-files \
	--append-system-prompt "$skill_dir/references/finding-validator.md" \
	-- "Verify this CodeFlow finding:

$(cat "$finding")" >"$verdict_file" 2>&1 </dev/null || run_status=$?

exit_code="$(exit_for_run "$run_status" "$(cat "$verdict_file")")"
if [ "$exit_code" = 4 ]; then
	echo "validator subagent failed (exit $run_status / timeout / spawn failure) — output:" >&2
	cat "$verdict_file" >&2
	exit 4
fi

out="$(cat "$verdict_file")"
printf '%s\n' "$out"

if [ "$exit_code" = 3 ]; then
	echo "no VERDICT line in validator output" >&2
fi
exit "$exit_code"
