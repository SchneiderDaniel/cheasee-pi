#!/usr/bin/env bash
# Phase 3b (use case) — audit.sh invocation contract: one check at a time, the
# default branch read from the repo, admin required, GET requests only.
#
# Sourced by tests/lib/run-case.sh (via tests/scripts.test.sh).

printf '\n== Phase 3b: audit.sh — invocation and preflight ==\n'

reset_all
begin "--check gathers only that check's endpoints"
run audit --json --check branch-protection
expect_rc 0
expect_eq "row count" "$(jq 'length' <<<"$LAST_OUT")" "1"
expect_eq "requests" "$(log_paths | tr '\n' '|')" "GET /repos/owner/repo|GET /repos/owner/repo/branches/main/protection|GET /repos/owner/repo/rules/branches/main|"

reset_all
begin "an unknown check id is rejected and lists the valid ids"
run audit --json --check not-a-check
expect_rc_nonzero
expect_err_has "branch-protection"
expect_err_has "community-security-policy"
expect_eq "rows" "$(log_count)" "0"

reset_all
set_state .admin 'false'
begin "preflight without admin stops before any check endpoint"
run audit --json
expect_rc_nonzero
expect_err_has "admin"
expect_eq "requests" "$(log_paths | tr '\n' '|')" "GET /repos/owner/repo|"

reset_all
set_state .default_branch '"develop"'
begin "the default branch is read from the repo, never hardcoded"
run audit --json --check branch-protection
expect_rc 0
if log_paths | grep -q '/branches/develop/protection'; then
	ok "$CUR targets /branches/develop/protection"
else
	nok "$CUR: expected a /branches/develop/protection request (got: $(log_paths | tr '\n' '|'))"
fi
if log_paths | grep -q 'main'; then
	nok "$CUR: unexpected reference to main"
else
	ok "$CUR never mentions main"
fi

reset_all
make_all_pass
begin "a full audit issues GET requests only"
run audit --json
expect_rc 0
expect_eq "methods" "$(log_methods | sort -u | tr '\n' ' ')" "GET "

