#!/usr/bin/env bash
# Phase 2 (adapter) — repository resolution and the gh transport gateway.
#
# Sourced by tests/scripts.test.sh: it relies on the harness helpers and on the
# fake gh binary already being first on PATH.

printf '== Phase 2: adapters — repo resolution + gh gateway ==\n'

reset_all
begin "resolve_repo reads supervisor.repo from settings"
run resolve_repo_via_lib
expect_rc 0
expect_eq "repo" "$LAST_OUT" "owner/repo"

begin "explicit override beats settings value"
run resolve_repo_via_lib "other/name"
expect_rc 0
expect_eq "repo" "$LAST_OUT" "other/name"

begin "resolve_repo reads supervisor.repo from the checked-in settings file"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -n "$REPO_ROOT" && -f "$REPO_ROOT/.pi/settings.json" ]]; then
	expected=$(jq -r '.supervisor.repo' "$REPO_ROOT/.pi/settings.json")
	LAST_OUT=""
	LAST_ERR=""
	LAST_RC=0
	LAST_OUT=$(env -u GBPC_SETTINGS_FILE bash -c "cd '$REPO_ROOT' && source '$REPO_LIB' && resolve_repo" 2>"$WORK/.stderr") || LAST_RC=$?
	LAST_ERR=$(cat "$WORK/.stderr")
	expect_rc 0
	expect_eq "repo" "$LAST_OUT" "$expected"
else
	ok "$CUR (skipped: no git checkout or settings file)"
fi

for bad in "noslash" "a/b/c" ""; do
	begin "malformed repo value '$bad' is rejected without calling gh"
	before=$(log_count)
	run resolve_repo_via_lib "$bad"
	expect_rc_nonzero
	expect_err_has "owner/repo"
	expect_eq "gh calls" "$(log_count)" "$before"
done

begin "malformed settings value is rejected"
printf '%s' '{"supervisor":{"repo":"broken"}}' >"$WORK/bad-settings.json"
before=$(log_count)
LAST_OUT=""
LAST_ERR=""
LAST_RC=0
LAST_OUT=$(GBPC_SETTINGS_FILE="$WORK/bad-settings.json" bash -c "source '$REPO_LIB' && resolve_repo" 2>"$WORK/.stderr") || LAST_RC=$?
LAST_ERR=$(cat "$WORK/.stderr")
expect_rc_nonzero
expect_err_has "owner/repo"
expect_eq "gh calls" "$(log_count)" "$before"

begin "missing supervisor.repo is rejected with an actionable message"
printf '%s' '{"supervisor":{}}' >"$WORK/empty-settings.json"
LAST_OUT=""
LAST_ERR=""
LAST_RC=0
LAST_OUT=$(GBPC_SETTINGS_FILE="$WORK/empty-settings.json" bash -c "source '$REPO_LIB' && resolve_repo" 2>"$WORK/.stderr") || LAST_RC=$?
LAST_ERR=$(cat "$WORK/.stderr")
expect_rc_nonzero
expect_err_has "supervisor.repo"

begin "gateway GET sends an explicit --method and no field flags"
reset_all
run gateway GET "/repos/owner/repo"
expect_rc 0
expect_eq "status" "$(jq -r '.status' <<<"$LAST_OUT")" "200"
expect_eq "argv" "$(argv_log)" "api --include --method GET /repos/owner/repo"

begin "gateway PUT delivers the body through --input"
reset_all
run gateway PUT "/repos/owner/repo/vulnerability-alerts" '{"a":1}'
expect_rc 0
expect_eq "argv" "$(argv_log)" "api --include --method PUT /repos/owner/repo/vulnerability-alerts --input -"
if argv_log | grep -Eq -- '(^| )-(f|F)( |$)'; then
	nok "$CUR: gateway must never use -f/-F (they flip the method to POST and stringify values)"
else
	ok "$CUR argv has no -f/-F"
fi

begin "gateway preserves a 404 response instead of folding it into pass"
reset_all
run gateway GET "/repos/owner/repo/branches/main/protection"
expect_rc 0
expect_eq "status" "$(jq -r '.status' <<<"$LAST_OUT")" "404"
expect_eq "body" "$(jq -r '.body.message' <<<"$LAST_OUT")" "Branch not protected"

begin "gateway surfaces transport failures and never fabricates a status"
reset_all
LAST_OUT=""
LAST_ERR=""
LAST_RC=0
LAST_OUT=$(GH_FAKE_TRANSPORT_ERROR="connection refused" bash -c "source '$GATEWAY' && gh_request GET /repos/owner/repo" 2>"$WORK/.stderr") || LAST_RC=$?
LAST_ERR=$(cat "$WORK/.stderr")
expect_rc_nonzero
expect_eq "stdout" "$LAST_OUT" ""
expect_err_has "connection refused"

begin "gateway is the only gh caller under scripts/"
hits=$(grep -rl 'gh api' "$SKILL_DIR/scripts" | sort | tr '\n' ' ')
expect_eq "files calling gh api" "$hits" "$SKILL_DIR/scripts/lib/gateway.sh "

