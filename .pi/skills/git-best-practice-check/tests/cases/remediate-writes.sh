#!/usr/bin/env bash
# Phase 4b (use case) — one write per security/branch practice, with the
# read-modify-write and the asynchronous code-scanning poll.
#
# Sourced by tests/lib/run-case.sh (via tests/scripts.test.sh).

printf '\n== Phase 4b: remediate.sh — one write per practice ==\n'

reset_all
begin "branch protection remediation writes one complete PUT"
run remediate branch-protection --consent
expect_rc 0
expect_eq "writes" "$(write_lines | tr '\n' '|')" "PUT /repos/owner/repo/branches/main/protection|"
prot_body="$(body_of PUT /repos/owner/repo/branches/main/protection)"
expect_eq "top-level keys" "$(jq -r 'keys | sort | join(",")' "$prot_body")" "enforce_admins,required_pull_request_reviews,required_status_checks,restrictions"
expect_eq "review count" "$(jq -r '.required_approving_review_count // .required_pull_request_reviews.required_approving_review_count' "$prot_body")" "1"
expect_eq "admins enforced" "$(jq -r '.enforce_admins' "$prot_body")" "true"
expect_eq "status checks" "$(jq -c '.required_status_checks' "$prot_body")" "null"
expect_eq "restrictions" "$(jq -c '.restrictions' "$prot_body")" "null"
expect_out_has "fail → pass"

reset_all
set_state .protection '{"required_status_checks":{"strict":true,"contexts":["ci/legacy"],"checks":[{"context":"ci/test","app_id":-1}]},"enforce_admins":{"enabled":false},"required_pull_request_reviews":{"required_approving_review_count":0,"dismiss_stale_reviews":true,"require_code_owner_reviews":false},"restrictions":{"users":[{"login":"octocat"},{"login":"hubot"}],"teams":[{"slug":"core"}],"apps":[{"slug":"octo-app"}]}}'
begin "branch protection remediation preserves the existing config"
run remediate branch-protection --consent
expect_rc 0
prot_body="$(body_of PUT /repos/owner/repo/branches/main/protection)"
expect_eq "checks" "$(jq -c '.required_status_checks.checks' "$prot_body")" '[{"context":"ci/test","app_id":-1}]'
expect_eq "contexts" "$(jq -c '.required_status_checks.contexts' "$prot_body")" '["ci/legacy"]'
expect_eq "strict" "$(jq -r '.required_status_checks.strict' "$prot_body")" "true"
expect_eq "restriction users" "$(jq -c '.restrictions.users' "$prot_body")" '["octocat","hubot"]'
expect_eq "restriction teams" "$(jq -c '.restrictions.teams' "$prot_body")" '["core"]'
expect_eq "dismiss stale reviews" "$(jq -r '.required_pull_request_reviews.dismiss_stale_reviews' "$prot_body")" "true"
expect_eq "review count" "$(jq -r '.required_pull_request_reviews.required_approving_review_count' "$prot_body")" "1"

reset_all
begin "dependabot remediation enables alerts through the dedicated endpoint"
run remediate dependabot-alerts --consent
expect_rc 0
expect_eq "writes" "$(write_lines | tr '\n' '|')" "PUT /repos/owner/repo/vulnerability-alerts|"
expect_out_has "fail → pass"

reset_all
begin "secret scanning remediation patches the repo, not a phantom endpoint"
run remediate secret-scanning --consent
expect_rc 0
expect_eq "writes" "$(write_lines | tr '\n' '|')" "PATCH /repos/owner/repo|"
secret_body="$(body_of PATCH /repos/owner/repo)"
expect_eq "secret_scanning status" "$(jq -r '.security_and_analysis.secret_scanning.status' "$secret_body")" "enabled"
if log_paths | grep -q 'secret-scanning'; then
	nok "$CUR: PUT /secret-scanning does not exist in the GitHub API"
else
	ok "$CUR never calls a secret-scanning settings endpoint"
fi

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
if write_lines | grep -q '^PUT'; then
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

