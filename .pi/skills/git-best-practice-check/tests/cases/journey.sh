#!/usr/bin/env bash
# Phases 6 + 7 — the maintainer user journey and the hygiene guards.
#
# Sourced by tests/scripts.test.sh.

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

printf '\n== Phase 7: hygiene / regression guards ==\n'

begin "audit and remediate never touch the working tree"
tree_before=$(git status --porcelain 2>/dev/null | sort)
settings_before=$(git diff -- .pi/settings.json 2>/dev/null)
reset_all
run audit --json
run remediate dependabot-alerts --consent
tree_after=$(git status --porcelain 2>/dev/null | sort)
settings_after=$(git diff -- .pi/settings.json 2>/dev/null)
expect_eq "git status" "$tree_after" "$tree_before"
expect_eq "settings diff" "$settings_after" "$settings_before"

begin "no new dependency is introduced"
run git diff --stat -- package.json package-lock.json
expect_rc 0
expect_eq "diff" "$LAST_OUT" ""

begin "an audit run issues GET requests only"
reset_all
make_all_pass
run audit --json
expect_eq "methods" "$(log_methods | sort -u | tr '\n' ' ')" "GET "

begin "every shell file parses and remediate.sh never disables errexit"
parse_ok=1
for f in "$SKILL_DIR"/scripts/*.sh "$SKILL_DIR"/scripts/lib/*.sh "$SKILL_DIR"/tests/*.sh "$SKILL_DIR"/tests/cases/*.sh; do
	bash -n "$f" || parse_ok=0
done
expect_eq "every shell file parses (1 = yes)" "$parse_ok" "1"
if grep -q 'set +e' "$REMEDIATE"; then
	nok "$CUR: remediate.sh must not swallow errors with set +e"
else
	ok "$CUR no set +e"
fi
