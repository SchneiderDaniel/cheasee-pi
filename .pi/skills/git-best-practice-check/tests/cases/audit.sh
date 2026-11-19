#!/usr/bin/env bash
# Phase 3 (use case) — audit.sh gathers evidence read-only and reports it.
#
# Sourced by tests/scripts.test.sh.

printf '\n== Phase 3: audit.sh — read-only gathering ==\n'

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

reset_all
begin "--check gathers only that check's endpoints"
run audit --json --check branch-protection
expect_rc 0
expect_eq "row count" "$(jq 'length' <<<"$LAST_OUT")" "1"
expect_eq "requests" "$(log_paths | tr '\n' '|')" "GET /repos/owner/repo|GET /repos/owner/repo/branches/main/protection|GET /repos/owner/repo/rules/branches/main|"

reset_all
begin "an unknown check id is rejected and lists the valid ids"
run audit --json --check not-a-check
expect_rc_nonzero
expect_err_has "branch-protection"
expect_err_has "community-security-policy"
expect_eq "rows" "$(log_count)" "0"

reset_all
set_state .admin 'false'
begin "preflight without admin stops before any check endpoint"
run audit --json
expect_rc_nonzero
expect_err_has "admin"
expect_eq "requests" "$(log_paths | tr '\n' '|')" "GET /repos/owner/repo|"

reset_all
set_state .default_branch '"develop"'
begin "the default branch is read from the repo, never hardcoded"
run audit --json --check branch-protection
expect_rc 0
if log_paths | grep -q '/branches/develop/protection'; then
	ok "$CUR targets /branches/develop/protection"
else
	nok "$CUR: expected a /branches/develop/protection request (got: $(log_paths | tr '\n' '|'))"
fi
if log_paths | grep -q 'main'; then
	nok "$CUR: unexpected reference to main"
else
	ok "$CUR never mentions main"
fi

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
make_all_pass
begin "a full audit issues GET requests only"
run audit --json
expect_rc 0
expect_eq "methods" "$(log_methods | sort -u | tr '\n' ' ')" "GET "


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
