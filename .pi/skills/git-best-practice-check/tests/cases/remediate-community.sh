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
expect_eq "refs created" "$(count_write_lines 'git/refs')" "1"
expect_eq "pulls opened" "$(count_write_lines 'pulls')" "1"
expect_eq "file writes" "$(count_write_lines 'contents/')" "2"
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
