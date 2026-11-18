#!/usr/bin/env bash
# Phases 2, 3, 4, 6, 7 — adapters (repo resolution + gh gateway), audit.sh,
# remediate.sh, the maintainer journey, and the hygiene guards.
#
# Everything runs against tests/fixtures/fake-gh/gh: a stateful GitHub double
# that records every invocation in $GH_LOG and serves responses from a small
# state file plus an optional per-endpoint override plan. No network, no real
# repo mutation.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIT="$SKILL_DIR/scripts/audit.sh"
REMEDIATE="$SKILL_DIR/scripts/remediate.sh"
GATEWAY="$SKILL_DIR/scripts/lib/gateway.sh"
REPO_LIB="$SKILL_DIR/scripts/lib/repo.sh"
FAKE_BIN="$SKILL_DIR/tests/fixtures/fake-gh"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

export GH_LOG="$WORK/gh.log"
export GH_PLAN="$WORK/plan.json"
export GH_STATE_DIR="$WORK/state"
export GH_BODY_DIR="$WORK/request-bodies"
mkdir -p "$GH_STATE_DIR" "$GH_BODY_DIR"
: >"$GH_LOG"
: >"$GH_LOG.argv"

export PATH="$FAKE_BIN:$PATH"
unset GH_TOKEN GITHUB_TOKEN || true

mkdir -p "$WORK/settings/.pi"
printf '%s' '{"supervisor":{"repo":"owner/repo"}}' >"$WORK/settings/.pi/settings.json"
export GBPC_SETTINGS_FILE="$WORK/settings/.pi/settings.json"

CASES=0
FAILS=0
CUR=""
LAST_OUT=""
LAST_ERR=""
LAST_RC=0

ok() { printf 'ok - %s\n' "$*"; }
nok() {
	printf 'not ok - %s\n' "$*" >&2
	FAILS=$((FAILS + 1))
}
begin() {
	CUR="$1"
	CASES=$((CASES + 1))
}
expect_rc() {
	if [[ "$LAST_RC" == "$1" ]]; then
		ok "$CUR → exit $1"
	else
		nok "$CUR: expected exit $1, got $LAST_RC (stderr: $LAST_ERR)"
	fi
}
expect_rc_nonzero() {
	if [[ "$LAST_RC" != "0" ]]; then
		ok "$CUR → non-zero exit"
	else
		nok "$CUR: expected a non-zero exit, got 0 (stdout: $LAST_OUT)"
	fi
}
expect_out_has() {
	if [[ "$LAST_OUT" == *"$1"* ]]; then
		ok "$CUR stdout ~ $1"
	else
		nok "$CUR: stdout lacks '$1' (got: ${LAST_OUT:0:400})"
	fi
}
expect_out_lacks() {
	if [[ "$LAST_OUT" != *"$1"* ]]; then
		ok "$CUR stdout !~ $1"
	else
		nok "$CUR: stdout unexpectedly contains '$1'"
	fi
}
expect_err_has() {
	if [[ "$LAST_ERR" == *"$1"* ]]; then
		ok "$CUR stderr ~ $1"
	else
		nok "$CUR: stderr lacks '$1' (got: ${LAST_ERR:0:400})"
	fi
}
expect_eq() { # <label> <got> <want>
	if [[ "$2" == "$3" ]]; then
		ok "$CUR $1 = $3"
	else
		nok "$CUR: $1 expected [$3], got [$2]"
	fi
}

run() { # <command...>
	LAST_OUT=""
	LAST_ERR=""
	LAST_RC=0
	LAST_OUT=$("$@" 2>"$WORK/.stderr") || LAST_RC=$?
	LAST_ERR=$(cat "$WORK/.stderr")
}

# ---------------------------------------------------------------------------
# harness helpers
# ---------------------------------------------------------------------------
STATE_DEFAULT='{"admin":true,"default_branch":"main","secret_scanning":"disabled","vulnerability_alerts":"disabled","code_scanning":"not-configured","analyses":0,"protection":null,"rules":[],"files":[],"health_percentage":0,"head_sha":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}'
STATE_FILE="$GH_STATE_DIR/state.json"

plan_reset() {
	printf '%s' '{"responses":{},"default":{"status":404,"body":{"message":"Not Found"}}}' >"$GH_PLAN"
}

plan_set() { # <method> <path> <response-json>
	jq --arg k "$1 $2" --argjson v "$3" '.responses[$k] = $v' "$GH_PLAN" >"$WORK/.plan.tmp"
	mv "$WORK/.plan.tmp" "$GH_PLAN"
}

plan_seq() { # <method> <path> <array-of-responses-json>
	plan_set "$1" "$2" "{\"sequence\":$3}"
}

set_state() { # <jq path> <json value>
	jq --argjson v "$2" "$1 = \$v" "$STATE_FILE" >"$WORK/.state.tmp"
	mv "$WORK/.state.tmp" "$STATE_FILE"
}

reset_all() {
	rm -rf "$GH_STATE_DIR" "$GH_BODY_DIR"
	mkdir -p "$GH_STATE_DIR" "$GH_BODY_DIR"
	printf '%s' "$STATE_DEFAULT" >"$STATE_FILE"
	plan_reset
	: >"$GH_LOG"
	: >"$GH_LOG.argv"
}

make_all_pass() {
	set_state .vulnerability_alerts '"enabled"'
	set_state .secret_scanning '"enabled"'
	set_state .code_scanning '"configured"'
	set_state .analyses '1'
	set_state .health_percentage '100'
	set_state .protection '{"required_status_checks":null,"enforce_admins":{"enabled":true},"required_pull_request_reviews":{"required_approving_review_count":1,"dismiss_stale_reviews":false,"require_code_owner_reviews":false},"restrictions":null}'
	set_state .files '["README.md","CODE_OF_CONDUCT.md","CONTRIBUTING.md","LICENSE","SECURITY.md",".github/ISSUE_TEMPLATE/bug_report.md",".github/PULL_REQUEST_TEMPLATE.md"]'
}

log_count() {
	local n
	n=$(wc -l <"$GH_LOG")
	printf '%s' "${n//[!0-9]/}"
}
log_methods() { awk -F'\t' '{print $1}' "$GH_LOG"; }
log_paths() { awk -F'\t' '{print $1" "$2}' "$GH_LOG"; }
write_lines() { awk -F'\t' '$1 != "GET" {print $1" "$2}' "$GH_LOG"; }
write_count() { write_lines | grep -c . || true; }
body_of() { awk -F'\t' -v m="$1" -v p="$2" '$1 == m && $2 == p {print $3}' "$GH_LOG" | head -1; }
get_count() { awk -F'\t' -v p="$1" '$1 == "GET" && index($2, p) > 0 {n++} END {print n+0}' "$GH_LOG"; }
argv_log() { cat "$GH_LOG.argv"; }

audit() { bash "$AUDIT" "$@"; }
remediate() { bash "$REMEDIATE" "$@"; }
gateway() { (source "$GATEWAY" && gh_request "$@"); }
resolve_repo_via_lib() { (source "$REPO_LIB" && resolve_repo "$@"); }

row_status() { jq -r ".[$1].status" <<<"$LAST_OUT"; }

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
	begin "malformed repo value '%s' is rejected without calling gh" "$bad"
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

printf '\n== Phase 3: audit.sh — read-only gathering ==\n'

reset_all
make_all_pass
begin "full audit of a healthy repo passes every practice"
run audit --json
expect_rc 0
expect_eq "row count" "$(jq 'length' <<<"$LAST_OUT")" "11"
expect_eq "non-pass rows" "$(jq '[.[] | select(.status != "pass")] | length' <<<"$LAST_OUT")" "0"
expect_eq "row shape" "$(jq -r '.[0] | keys | join(",")' <<<"$LAST_OUT")" "evidence,id,practice,remediable,status"

reset_all
begin "full audit of a bare repo fails every practice with evidence"
run audit --json
expect_rc 0
expect_eq "fail rows" "$(jq '[.[] | select(.status == "fail")] | length' <<<"$LAST_OUT")" "11"
expect_eq "rows without evidence" "$(jq '[.[] | select((.evidence | length) == 0)] | length' <<<"$LAST_OUT")" "0"

reset_all
plan_set GET /repos/owner/repo/rules/branches/main '{"status":403,"body":{"message":"Forbidden"}}'
begin "an unknown row fails closed while the table is still printed"
run audit
expect_rc 1
expect_out_has "branch-protection"
expect_out_has "unknown"

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
plan_set GET /repos/owner/repo/code-scanning/default-setup '{"status":403,"body":{"message":"GitHub Advanced Security is not enabled for this repository"}}'
plan_set GET /repos/owner/repo/code-scanning/analyses '{"status":403,"body":null}'
plan_seq GET /repos/owner/repo '[{"status":200,"body":{"default_branch":"main","permissions":{"admin":true},"security_and_analysis":{"secret_scanning":{"status":"disabled"}}}},{"status":403,"body":{"message":"Forbidden"}}]'
begin "plan-gated security features report not-available, not fail"
run audit --json
expect_rc 0
expect_eq "code-scanning" "$(jq -r '.[] | select(.id == "code-scanning") | .status' <<<"$LAST_OUT")" "not-available"
expect_eq "secret-scanning" "$(jq -r '.[] | select(.id == "secret-scanning") | .status' <<<"$LAST_OUT")" "not-available"
expect_eq "remediable flags" "$(jq -r '[.[] | select(.id == "code-scanning" or .id == "secret-scanning") | .remediable] | unique | join(",")' <<<"$LAST_OUT")" "false"

reset_all
make_all_pass
begin "a full audit issues GET requests only"
run audit --json
expect_rc 0
expect_eq "methods" "$(log_methods | sort -u | tr '\n' ' ')" "GET "

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

begin "every script parses and remediate.sh never disables errexit"
parse_ok=1
for f in "$SKILL_DIR"/scripts/*.sh "$SKILL_DIR"/scripts/lib/*.sh "$SKILL_DIR"/tests/*.sh; do
	bash -n "$f" || parse_ok=0
done
expect_eq "bash -n failures" "$parse_ok" "1"
if grep -q 'set +e' "$REMEDIATE"; then
	nok "$CUR: remediate.sh must not swallow errors with set +e"
else
	ok "$CUR no set +e"
fi

printf '\n%d cases, %d failures\n' "$CASES" "$FAILS"
((FAILS == 0)) || exit 1
