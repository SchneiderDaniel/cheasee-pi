#!/usr/bin/env bash
# Phase 4d (use case) — the re-verification contract every practice shares:
# a practice that already passes is refused, a rejected write is surfaced, and a
# write that does not change the evidence fails re-verification.
#
# Sourced by tests/lib/run-case.sh (via tests/scripts.test.sh).

printf '\n== Phase 4d: remediate.sh — re-verification contract ==\n'

reset_all
plan_seq GET /repos/owner/repo/vulnerability-alerts '[{"status":204,"body":null}]'
begin "remediation is refused when the practice already passes on re-audit"
run remediate dependabot-alerts --consent
expect_rc_nonzero
expect_err_has "dependabot-alerts"
expect_eq "writes" "$(write_count)" "0"

reset_all
plan_set PUT /repos/owner/repo/vulnerability-alerts '{"status":403,"body":{"message":"Resource not accessible by integration"}}'
begin "a rejected write surfaces the API status and body"
run remediate dependabot-alerts --consent
expect_rc_nonzero
expect_err_has "403"
expect_err_has "Resource not accessible"
expect_out_lacks "fail → pass"

reset_all
plan_seq GET /repos/owner/repo/branches/main/protection '[{"status":404,"body":{"message":"Branch not protected"}}]'
begin "a write that does not fix the practice fails re-verification"
run remediate branch-protection --consent
expect_rc_nonzero
expect_err_has "branch-protection"
expect_err_has "re-verify"
expect_out_lacks "fail → pass"


reset_all
begin "remediation refuses an explicitly empty --repo instead of touching another repo"
run remediate dependabot-alerts --consent --repo ""
expect_rc_nonzero
expect_err_has "empty --repo"
expect_eq "requests" "$(log_count)" "0"

reset_all
set_state .default_branch '"release/2026"'
begin "branch protection remediation encodes a slash-containing default branch"
run remediate branch-protection --consent
expect_rc 0
expect_eq "writes" "$(write_lines | tr '\n' '|')" "PUT /repos/owner/repo/branches/release%2F2026/protection|"
if log_path_has '/branches/release/2026'; then
	nok "$CUR sent an unencoded branch path"
else
	ok "$CUR encodes the branch path"
fi
expect_out_has "fail → pass"
