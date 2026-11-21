#!/usr/bin/env bash
# Phase 7 (adapter) — hygiene and regression guards: no working-tree mutation,
# no new dependency, no writes during an audit, and every shell file parses.
#
# Sourced by tests/lib/run-case.sh (via tests/scripts.test.sh).

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
