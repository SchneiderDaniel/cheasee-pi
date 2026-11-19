#!/usr/bin/env bash
# Phase 4 (use case) — the consent gate and the one-write-per-practice rule.
#
# Sourced by tests/scripts.test.sh.

printf '\n== Phase 4: remediate.sh — consent gate + one write per practice ==\n'

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
set_state .analyses '1'
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
set_state .analyses '1'
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

reset_all
begin "community remediation opens one branch and one PR for the missing files"
run remediate community-issue-templates --consent
expect_rc 0
expect_eq "refs created" "$(write_lines | grep -c 'git/refs' || true)" "1"
expect_eq "pulls opened" "$(write_lines | grep -c 'pulls' || true)" "1"
expect_eq "file writes" "$(write_lines | grep -c 'contents/' || true)" "2"
ref_body="$(body_of POST /repos/owner/repo/git/refs)"
branch=$(jq -r '.ref | sub("^refs/heads/"; "")' "$ref_body")
expect_eq "branch head" "$(jq -r '.sha' "$ref_body")" "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
without_branch=0
while IFS= read -r bf; do
	[[ -z "$bf" ]] && continue
	[[ "$(jq -r '.branch // ""' "$bf")" == "$branch" ]] || without_branch=$((without_branch + 1))
done < <(awk -F'\t' '$1 == "PUT" && $2 ~ /contents\// {print $3}' "$GH_LOG")
expect_eq "contents writes missing branch" "$without_branch" "0"
pr_body="$(body_of POST /repos/owner/repo/pulls)"
expect_eq "pr base" "$(jq -r '.base' "$pr_body")" "main"
expect_eq "pr head" "$(jq -r '.head' "$pr_body")" "$branch"

reset_all
begin "license remediation fills the template year and copyright holder"
run remediate community-license --consent --fullname "Ada Lovelace" --license-key mit
expect_rc 0
lic_body="$(body_of PUT /repos/owner/repo/contents/LICENSE)"
lic_text=$(jq -r '.content' "$lic_body" | base64 -d)
expect_out_has "fail → pass"
if [[ "$lic_text" == *"$(date -u +%Y)"* && "$lic_text" == *"Ada Lovelace"* ]]; then
	ok "$CUR license carries year and holder"
else
	nok "$CUR: license text missing year/holder: ${lic_text:0:200}"
fi

reset_all
begin "license remediation refuses without a copyright holder"
run remediate community-license --consent
expect_rc_nonzero
expect_err_has "--fullname"
expect_eq "writes" "$(write_count)" "0"

reset_all
set_state .vulnerability_alerts '"disabled"'
plan_seq GET /repos/owner/repo/vulnerability-alerts '[{"status":404,"body":{"message":"Not Found"}},{"status":204,"body":null},{"status":204,"body":null}]'
begin "remediation reports the fail -> pass transition after re-verification"
run remediate dependabot-alerts --consent
# The re-audit sees 404 (fail), the write lands, the re-verify sees 204 (pass).
expect_rc 0
expect_out_has "fail → pass"
expect_eq "writes" "$(write_count)" "1"

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

