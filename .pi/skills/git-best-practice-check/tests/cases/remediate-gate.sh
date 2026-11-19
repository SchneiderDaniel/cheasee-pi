#!/usr/bin/env bash
# Phase 4a (use case) — the consent gate: nothing is written without --consent,
# only `fail` rows are remediated, and unknown ids are rejected.
#
# Sourced by tests/lib/run-case.sh (via tests/scripts.test.sh).

printf '\n== Phase 4a: remediate.sh — consent and state gates ==\n'

reset_all
begin "remediation without --consent performs no write"
run remediate branch-protection
expect_rc_nonzero
expect_err_has "consent"
expect_eq "writes" "$(write_count)" "0"

reset_all
make_all_pass
begin "a passing practice is not remediated"
run remediate dependabot-alerts --consent
expect_rc_nonzero
expect_err_has "dependabot-alerts"
expect_eq "writes" "$(write_count)" "0"

reset_all
set_state .code_scanning '"configured"'
set_state .analyses '0'
begin "a pending practice is not remediated"
run remediate code-scanning --consent
expect_rc_nonzero
expect_err_has "pending"
expect_eq "writes" "$(write_count)" "0"

reset_all
plan_set GET /repos/owner/repo/code-scanning/default-setup '{"status":403,"body":null}'
plan_set GET /repos/owner/repo/code-scanning/analyses '{"status":403,"body":null}'
begin "a plan-gated practice is not remediated"
run remediate code-scanning --consent
expect_rc_nonzero
expect_err_has "not-available"
expect_eq "writes" "$(write_count)" "0"

reset_all
plan_set GET /repos/owner/repo/rules/branches/main '{"status":403,"body":null}'
begin "an unknown status blocks remediation"
run remediate branch-protection --consent
expect_rc_nonzero
expect_err_has "unknown"
expect_eq "writes" "$(write_count)" "0"

reset_all
begin "an unknown check id is rejected before any write"
run remediate nope --consent
expect_rc_nonzero
expect_err_has "branch-protection"
expect_eq "writes" "$(write_count)" "0"

