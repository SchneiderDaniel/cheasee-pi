#!/usr/bin/env bash
# Phase 4c (use case) — community-file remediation through a feature branch and
# a pull request, plus the re-verification contract every practice shares.
#
# Sourced by tests/lib/run-case.sh (via tests/scripts.test.sh).

printf '\n== Phase 4c: remediate.sh — community files and re-verification ==\n'

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
if log_paths | grep -Eq '/branches/release/2026'; then
	nok "$CUR sent an unencoded branch path"
else
	ok "$CUR encodes the branch path"
fi
expect_out_has "fail → pass"
