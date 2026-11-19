#!/usr/bin/env bash
# Phase 3c (use case) — plan gating, argument rejection, percent-encoded branch
# paths and the code-scanning recency rule.
#
# Sourced by tests/lib/run-case.sh (via tests/scripts.test.sh).

printf '\n== Phase 3c: audit.sh — gating, branch encoding, recency ==\n'

reset_all
plan_set GET /repos/owner/repo/code-scanning/default-setup '{"status":403,"body":{"message":"GitHub Advanced Security is not enabled for this repository"}}'
plan_set GET /repos/owner/repo/code-scanning/analyses '{"status":403,"body":null}'
plan_seq GET /repos/owner/repo '[{"status":200,"body":{"default_branch":"main","permissions":{"admin":true},"security_and_analysis":{"secret_scanning":{"status":"disabled"}}}},{"status":403,"body":{"message":"Forbidden"}}]'
begin "plan-gated security features report not-available, not fail"
run audit --json
expect_rc 0
expect_eq "code-scanning" "$(jq -r '.[] | select(.id == "code-scanning") | .status' <<<"$LAST_OUT")" "not-available"
expect_eq "secret-scanning" "$(jq -r '.[] | select(.id == "secret-scanning") | .status' <<<"$LAST_OUT")" "not-available"
expect_eq "remediable flags" "$(jq -r '[.[] | select(.id == "code-scanning" or .id == "secret-scanning") | .remediable] | unique | join(",")' <<<"$LAST_OUT")" "false"


reset_all
begin "an explicitly empty --repo is rejected, never replaced by the settings value"
before=$(log_count)
run audit --json --repo ""
expect_rc_nonzero
expect_err_has "empty --repo"
expect_eq "requests" "$(log_count)" "$before"

reset_all
set_state .default_branch '"release/2026"'
begin "a default branch containing a slash is percent-encoded in request paths"
run audit --json --check branch-protection
expect_rc 0
if log_paths | grep -q '/branches/release%2F2026/protection'; then
	ok "$CUR encodes the branch in the protection path"
else
	nok "$CUR: expected /branches/release%2F2026/protection (got: $(log_paths | tr '\n' '|'))"
fi
if log_paths | grep -q '/rules/branches/release%2F2026'; then
	ok "$CUR encodes the branch in the effective-rules path"
else
	nok "$CUR: expected /rules/branches/release%2F2026 (got: $(log_paths | tr '\n' '|'))"
fi
if log_paths | grep -Eq '/branches/release/2026|/rules/branches/release/2026'; then
	nok "$CUR sends an unencoded branch path"
else
	ok "$CUR never sends an unencoded branch path"
fi

reset_all
set_state .code_scanning '"not-configured"'
set_state .analyses '1'
set_state .analyses_age_days '2'
begin "workflow-mode scanning with a recent analysis passes"
run audit --json --check code-scanning
expect_rc 0
expect_eq "status" "$(jq -r '.[0].status' <<<"$LAST_OUT")" "pass"

reset_all
set_state .code_scanning '"not-configured"'
set_state .analyses '1'
set_state .analyses_age_days '400'
begin "workflow-mode scanning with only stale analyses fails"
run audit --json --check code-scanning
expect_rc 0
expect_eq "status" "$(jq -r '.[0].status' <<<"$LAST_OUT")" "fail"
expect_out_has "days old"

reset_all
set_state .code_scanning '"not-configured"'
set_state .analyses '1'
set_state .analyses_age_days '2'
begin "the audit hands its clock to the recency rule (GBPC_NOW pins it)"
run env GBPC_NOW="$(( $(date -u +%s) + 400 * 86400 ))" bash "$AUDIT" --json --check code-scanning
expect_rc 0
expect_eq "status" "$(jq -r '.[0].status' <<<"$LAST_OUT")" "fail"
expect_out_has "days old"
