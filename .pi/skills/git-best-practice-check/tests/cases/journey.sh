#!/usr/bin/env bash
# Phase 6 (user journey) — the maintainer audits a fresh repository, fixes two
# practices with consent and leaves a third untouched, end to end.
#
# Sourced by tests/lib/run-case.sh (via tests/scripts.test.sh).

printf '\n== Phase 6: user journey — audit a fresh repo, fix two practices ==\n'


reset_all
begin "journey: the audit table lists every practice with evidence for each fail"
run audit
expect_rc 0
table_rows=$(printf '%s\n' "$LAST_OUT" | grep -cE '^(branch-protection|dependabot-alerts|code-scanning|secret-scanning|community-)' || true)
expect_eq "table rows" "$table_rows" "11"
expect_out_has "required_approving_review_count=0"
expect_out_has "vulnerability-alerts -> 404"

begin "journey: two consented practices are fixed, a third is left untouched"
run remediate branch-protection --consent
expect_rc 0
expect_out_has "fail → pass"
run remediate dependabot-alerts --consent
expect_rc 0
expect_out_has "fail → pass"
if write_lines | grep -q 'contents/'; then
	nok "$CUR: the community files were touched without consent"
else
	ok "$CUR community files untouched"
fi

begin "journey: re-running the audit shows the two fixes and the remaining fails"
run audit --json
expect_rc 0
expect_eq "branch-protection" "$(jq -r '.[] | select(.id == "branch-protection") | .status' <<<"$LAST_OUT")" "pass"
expect_eq "dependabot-alerts" "$(jq -r '.[] | select(.id == "dependabot-alerts") | .status' <<<"$LAST_OUT")" "pass"
expect_eq "community-readme" "$(jq -r '.[] | select(.id == "community-readme") | .status' <<<"$LAST_OUT")" "fail"

begin "journey: declining remediation leaves the repo untouched and says why"
reset_all
before=$(log_count)
run remediate community-readme
expect_rc_nonzero
expect_err_has "consent"
expect_eq "writes" "$(write_count)" "0"
