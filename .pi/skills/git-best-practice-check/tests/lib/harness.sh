#!/usr/bin/env bash
# harness.sh — shared setup, fake-gh wiring and assertions for the shell suites.
#
# One case slice (tests/cases/*.sh) runs per process: tests/lib/run-case.sh
# sources this file, then the slice, then calls `finish`. Each process gets its
# own temp workspace, gh log, response plan and state directory, so slices are
# independent and can run in parallel — which is what keeps the suite inside its
# runtime budget on a machine where every jq start-up costs milliseconds.
#
# Everything runs against tests/fixtures/fake-gh/gh: a stateful GitHub double
# that records every invocation in $GH_LOG and serves responses from a small
# state file plus an optional per-endpoint override plan. No network, no
# mutation of the real repository.
set -uo pipefail

SKILL_DIR="${SKILL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
AUDIT="$SKILL_DIR/scripts/audit.sh"
REMEDIATE="$SKILL_DIR/scripts/remediate.sh"
GATEWAY="$SKILL_DIR/scripts/lib/gateway.sh"
REPO_LIB="$SKILL_DIR/scripts/lib/repo.sh"
FAKE_BIN="$SKILL_DIR/tests/fixtures/fake-gh"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

export GH_LOG="$WORK/gh.log"
export GH_PLAN="$WORK/plan.json"
export GH_STATE_DIR="$WORK/state"
export GH_BODY_DIR="$WORK/request-bodies"
mkdir -p "$GH_STATE_DIR" "$GH_BODY_DIR"
: >"$GH_LOG"
: >"$GH_LOG.argv"

export PATH="$FAKE_BIN:$PATH"
unset GH_TOKEN GITHUB_TOKEN || true

mkdir -p "$WORK/settings/.pi"
printf '%s' '{"supervisor":{"repo":"owner/repo"}}' >"$WORK/settings/.pi/settings.json"
export GBPC_SETTINGS_FILE="$WORK/settings/.pi/settings.json"

# Polling sleeps are the one thing tests must not inherit from the defaults: a
# case that asserts the poll loop still pins its own attempt count.
export GBPC_POLL_INTERVAL="${GBPC_POLL_INTERVAL:-0}"

CASES=0
FAILS=0
CUR=""
LAST_OUT=""
LAST_ERR=""
LAST_RC=0

ok() { printf 'ok - %s\n' "$*"; }
nok() {
	printf 'not ok - %s\n' "$*" >&2
	FAILS=$((FAILS + 1))
}
begin() {
	CUR="$1"
	CASES=$((CASES + 1))
}
expect_rc() {
	if [[ "$LAST_RC" == "$1" ]]; then
		ok "$CUR → exit $1"
	else
		nok "$CUR: expected exit $1, got $LAST_RC (stderr: $LAST_ERR)"
	fi
}
expect_rc_nonzero() {
	if [[ "$LAST_RC" != "0" ]]; then
		ok "$CUR → non-zero exit"
	else
		nok "$CUR: expected a non-zero exit, got 0 (stdout: $LAST_OUT)"
	fi
}
expect_out_has() {
	if [[ "$LAST_OUT" == *"$1"* ]]; then
		ok "$CUR stdout ~ $1"
	else
		nok "$CUR: stdout lacks '$1' (got: ${LAST_OUT:0:400})"
	fi
}
expect_out_lacks() {
	if [[ "$LAST_OUT" != *"$1"* ]]; then
		ok "$CUR stdout !~ $1"
	else
		nok "$CUR: stdout unexpectedly contains '$1'"
	fi
}
expect_err_has() {
	if [[ "$LAST_ERR" == *"$1"* ]]; then
		ok "$CUR stderr ~ $1"
	else
		nok "$CUR: stderr lacks '$1' (got: ${LAST_ERR:0:400})"
	fi
}
expect_eq() { # <label> <got> <want>
	if [[ "$2" == "$3" ]]; then
		ok "$CUR $1 = $3"
	else
		nok "$CUR: $1 expected [$3], got [$2]"
	fi
}

run() { # <command...>
	LAST_OUT=""
	LAST_ERR=""
	LAST_RC=0
	LAST_OUT=$("$@" 2>"$WORK/.stderr") || LAST_RC=$?
	LAST_ERR=$(cat "$WORK/.stderr")
}

# ---------------------------------------------------------------------------
# harness helpers
# ---------------------------------------------------------------------------
STATE_DEFAULT='{"admin":true,"default_branch":"main","secret_scanning":"disabled","vulnerability_alerts":"disabled","code_scanning":"not-configured","analyses":0,"analyses_age_days":0,"protection":null,"rules":[],"files":[],"health_percentage":0,"head_sha":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}'
STATE_FILE="$GH_STATE_DIR/state.json"

plan_reset() {
	printf '%s' '{"responses":{},"default":{"status":404,"body":{"message":"Not Found"}}}' >"$GH_PLAN"
}

plan_set() { # <method> <path> <response-json>
	jq --arg k "$1 $2" --argjson v "$3" '.responses[$k] = $v' "$GH_PLAN" >"$WORK/.plan.tmp"
	mv "$WORK/.plan.tmp" "$GH_PLAN"
}

plan_seq() { # <method> <path> <array-of-responses-json>
	plan_set "$1" "$2" "{\"sequence\":$3}"
}

set_state() { # <jq path> <json value>
	jq --argjson v "$2" "$1 = \$v" "$STATE_FILE" >"$WORK/.state.tmp"
	mv "$WORK/.state.tmp" "$STATE_FILE"
}

reset_all() {
	rm -rf "$GH_STATE_DIR" "$GH_BODY_DIR"
	mkdir -p "$GH_STATE_DIR" "$GH_BODY_DIR"
	printf '%s' "$STATE_DEFAULT" >"$STATE_FILE"
	plan_reset
	: >"$GH_LOG"
	: >"$GH_LOG.argv"
}

make_all_pass() {
	set_state .vulnerability_alerts '"enabled"'
	set_state .secret_scanning '"enabled"'
	set_state .code_scanning '"configured"'
	set_state .analyses '1'
	set_state .health_percentage '100'
	set_state .protection '{"required_status_checks":null,"enforce_admins":{"enabled":true},"required_pull_request_reviews":{"required_approving_review_count":1,"dismiss_stale_reviews":false,"require_code_owner_reviews":false},"restrictions":null}'
	set_state .files '["README.md","CODE_OF_CONDUCT.md","CONTRIBUTING.md","LICENSE","SECURITY.md",".github/ISSUE_TEMPLATE/bug_report.md",".github/PULL_REQUEST_TEMPLATE.md"]'
}

log_count() {
	local n
	n=$(wc -l <"$GH_LOG")
	printf '%s' "${n//[!0-9]/}"
}
log_methods() { awk -F'\t' '{print $1}' "$GH_LOG"; }
log_paths() { awk -F'\t' '{print $1" "$2}' "$GH_LOG"; }
write_lines() { awk -F'\t' '$1 != "GET" {print $1" "$2}' "$GH_LOG"; }
write_count() { write_lines | grep -c . || true; }
body_of() { awk -F'\t' -v m="$1" -v p="$2" '$1 == m && $2 == p {print $3}' "$GH_LOG" | head -1; }
get_count() { awk -F'\t' -v p="$1" '$1 == "GET" && index($2, p) > 0 {n++} END {print n+0}' "$GH_LOG"; }
argv_log() { cat "$GH_LOG.argv"; }

audit() { bash "$AUDIT" "$@"; }
remediate() { bash "$REMEDIATE" "$@"; }
gateway() { (source "$GATEWAY" && gh_request "$@"); }
resolve_repo_via_lib() { (source "$REPO_LIB" && resolve_repo "$@"); }

row_status() { jq -r ".[$1].status" <<<"$LAST_OUT"; }


# finish — print this slice's summary and fail when it saw a failure.
finish() {
	printf '\n%d cases, %d failures\n' "$CASES" "$FAILS"
	((FAILS == 0)) || exit 1
	return 0
}
