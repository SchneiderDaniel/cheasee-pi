#!/usr/bin/env bash
# Phase 3a (use case) — a full audit run: gathering, verdicts, fail-closed exit.
#
# Sourced by tests/lib/run-case.sh (via tests/scripts.test.sh).

printf '\n== Phase 3a: audit.sh — full runs ==\n'

reset_all
make_all_pass
begin "full audit of a healthy repo passes every practice"
run audit --json
expect_rc 0
expect_eq "row count" "$(jq 'length' <<<"$LAST_OUT")" "11"
expect_eq "non-pass rows" "$(jq '[.[] | select(.status != "pass")] | length' <<<"$LAST_OUT")" "0"
expect_eq "row shape" "$(jq -r '.[0] | keys | join(",")' <<<"$LAST_OUT")" "evidence,id,practice,remediable,status"

reset_all
begin "full audit of a bare repo fails every practice with evidence"
run audit --json
expect_rc 0
expect_eq "fail rows" "$(jq '[.[] | select(.status == "fail")] | length' <<<"$LAST_OUT")" "11"
expect_eq "rows without evidence" "$(jq '[.[] | select((.evidence | length) == 0)] | length' <<<"$LAST_OUT")" "0"

reset_all
plan_set GET /repos/owner/repo/rules/branches/main '{"status":403,"body":{"message":"Forbidden"}}'
begin "an unknown row fails closed while the table is still printed"
run audit
expect_rc 1
expect_out_has "branch-protection"
expect_out_has "unknown"

