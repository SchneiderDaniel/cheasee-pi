#!/usr/bin/env bash
# Phase 4c (use case) — code-scanning remediation: PATCH default setup, then the
# asynchronous poll that waits for GitHub to switch it on.
#
# Sourced by tests/lib/run-case.sh (via tests/scripts.test.sh).

printf '\n== Phase 4c: remediate.sh — code-scanning default setup ==\n'

reset_all
# Default setup off and no analyses yet: the practice fails, so remediation runs.
# The first analyses read (re-audit) is still empty; the second (re-verify) shows
# the completed run GitHub produces after default setup is switched on.
plan_seq GET /repos/owner/repo/code-scanning/analyses '[{"status":200,"body":[]},{"status":200,"body":[{"id":1,"state":"completed"}]}]'
begin "code scanning remediation PATCHes default setup"
run remediate code-scanning --consent
expect_rc 0
expect_eq "writes" "$(write_lines | head -1)" "PATCH /repos/owner/repo/code-scanning/default-setup"
cs_body="$(body_of PATCH /repos/owner/repo/code-scanning/default-setup)"
expect_eq "state" "$(jq -r '.state' "$cs_body")" "configured"
if write_lines_have 'PUT /'; then
	nok "$CUR: default setup is PATCH, never PUT"
else
	ok "$CUR used no PUT"
fi
expect_out_has "fail → pass"

reset_all
plan_seq GET /repos/owner/repo/code-scanning/analyses '[{"status":200,"body":[]},{"status":200,"body":[{"id":1,"state":"completed"}]}]'
plan_seq GET /repos/owner/repo/code-scanning/default-setup '[{"status":200,"body":{"state":"not-configured"}},{"status":200,"body":{"state":"not-configured"}},{"status":200,"body":{"state":"not-configured"}},{"status":200,"body":{"state":"configured"}}]'
begin "code scanning polling waits for default setup to become configured"
GBPC_POLL_ATTEMPTS=5 GBPC_POLL_INTERVAL=0 run remediate code-scanning --consent
expect_rc 0
expect_out_has "fail → pass"
expect_eq "default-setup reads" "$(get_count code-scanning/default-setup)" "5"

reset_all
plan_seq GET /repos/owner/repo/code-scanning/default-setup '[{"status":200,"body":{"state":"not-configured"}}]'
begin "code scanning polling stops at the cap and reports pending"
GBPC_POLL_ATTEMPTS=3 GBPC_POLL_INTERVAL=0 run remediate code-scanning --consent
expect_rc 0
expect_out_has "pending"
expect_eq "default-setup reads" "$(get_count code-scanning/default-setup)" "4"

