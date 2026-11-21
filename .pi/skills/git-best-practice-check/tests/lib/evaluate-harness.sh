#!/usr/bin/env bash
# evaluate-harness.sh — the pure-function harness shared by the evaluate slices.
#
# Phase 1 of the test plan tests `evaluate.jq` as an entity: evidence JSON in,
# check JSON out. Every slice supplies the evidence bundle that audit.sh would
# have gathered and asserts on the status plus the human-readable evidence
# strings. Nothing here touches `gh`, the network, or the filesystem beyond a
# temp bin dir, so a slice can run standalone: `bash tests/cases/evaluate-*.sh`.
#
# The clock is an input, never a read: `TEST_NOW` is pinned and passed with
# `--argjson now`, and `evaluate_without_clock` proves the rule reports `unknown`
# rather than guessing.

SKILL_DIR="${SKILL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
EVALUATE="$SKILL_DIR/scripts/evaluate.jq"

CASES=0
FAILS=0
CUR=""
OUT=""

ok() { printf 'ok - %s\n' "$*"; }
nok() {
	printf 'not ok - %s\n' "$*" >&2
	FAILS=$((FAILS + 1))
}

# Fixed clock: evaluate.jq never reads one, audit.sh passes `--argjson now`.
TEST_NOW=1760000000
iso() { jq -n -r --argjson t "$1" '$t | todate'; } # epoch seconds -> ISO8601
ago() { printf '%s' "$((TEST_NOW - $1 * 86400))"; } # epoch seconds, N days back
evaluate() { # <id>, evidence on stdin
	jq -c -f "$EVALUATE" --arg id "$1" --argjson now "$TEST_NOW"
}
evaluate_without_clock() { # <id>, evidence on stdin — same call, no `now`
	jq -c -f "$EVALUATE" --arg id "$1"
}

check() { # <name> <id> <evidence-json>
	CUR="$1"
	CASES=$((CASES + 1))
	if ! OUT=$(printf '%s' "$3" | evaluate "$2"); then
		nok "$CUR: evaluate.jq exited non-zero"
		OUT='{}'
	fi
}

expect_status() { # <want>
	local got
	got=$(jq -r '.status // "missing"' <<<"$OUT")
	if [[ "$got" == "$1" ]]; then
		ok "$CUR → $1"
	else
		nok "$CUR: expected status $1, got $got: $OUT"
	fi
}

expect_evidence() { # <substring>
	local joined
	joined=$(jq -r '.evidence | join(" ; ")' <<<"$OUT" 2>/dev/null || printf '<none>')
	if [[ "$joined" == *"$1"* ]]; then
		ok "$CUR evidence ~ $1"
	else
		nok "$CUR: evidence does not mention '$1' (got: $joined)"
	fi
}

expect_field() { # <jq path> <want>
	local got
	got=$(jq -r "$1 | tostring" <<<"$OUT" 2>/dev/null || printf '<missing>')
	if [[ "$got" == "$2" ]]; then
		ok "$CUR $1 = $2"
	else
		nok "$CUR: $1 expected $2, got $got"
	fi
}

CTX='"slug":"owner/repo","default_branch":"main"'

# finish — print this slice's summary and fail when it saw a failure.
finish() {
	printf '\n%d cases, %d failures\n' "$CASES" "$FAILS"
	((FAILS == 0)) || exit 1
	return 0
}
