#!/usr/bin/env bash
# test/security-posture.test.sh
#
# Contract test for scripts/check-security-posture.sh (issue #1470).
# Runs the check script against a stubbed `gh` (PATH shim) — no network,
# no token, deterministic. Mirrors the test/docker-tree-sync.test.sh
# harness style (pass/fail counters + run_expect helpers).
#
# The shim emulates the real `gh api` contract:
#   2xx  -> exit 0, body on stdout (204: empty)
#   err  -> exit 1, `gh: <reason> (HTTP <code>)` on stderr
# and records every invocation (argv + GH_TOKEN) for endpoint assertions.
#
# Run:
#   bash test/security-posture.test.sh
#   bash -n scripts/check-security-posture.sh && bash test/security-posture.test.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SCRIPT="scripts/check-security-posture.sh"
WF=".github/workflows/security-posture.yml"

PASS=0
FAIL=0

pass() { echo "ok: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# assert_grep <pattern> <file> <description> — pattern must match (grep -F)
assert_grep() {
	local pat="$1" file="$2" desc="$3"
	if grep -Fq -- "$pat" "$file"; then
		pass "$desc"
	else
		fail "$desc (missing: $pat)"
	fi
}

# assert_grep_x <pattern> <file> <description> — pattern must match on a full line
assert_grep_x() {
	local pat="$1" file="$2" desc="$3"
	if grep -Fqx "$pat" "$file"; then
		pass "$desc"
	else
		fail "$desc (missing full line: $pat)"
	fi
}

# assert_grep_v <pattern> <file> <description> — pattern must NOT match
assert_grep_v() {
	local pat="$1" file="$2" desc="$3"
	if grep -Fq "$pat" "$file"; then
		fail "$desc (unexpected: $pat)"
	else
		pass "$desc"
	fi
}

# count <pattern> <file> — lines matching extended regex (non-empty)
count() {
	grep -Ec "$1" "$2" || true
}

# ---------------------------------------------------------------- shim

TMP="$(mktemp -d)"
SHIM="$TMP/bin"
FIXTURES="$TMP/fixtures"
LOG="$TMP/gh.log"
OUT="$TMP/out"
ERR="$TMP/err"
mkdir -p "$SHIM" "$FIXTURES"

# fake gh — emulates `gh api`: canned responses keyed by endpoint path
# (query string stripped), records argv + GH_TOKEN to $FAKE_GH_LOG.
cat > "$SHIM/gh" <<'EOF'
#!/usr/bin/env bash
{
	printf 'ARGV'
	for a in "$@"; do printf ' <%s>' "$a"; done
	printf ' GH_TOKEN=<%s>\n' "${GH_TOKEN:-}"
} >> "${FAKE_GH_LOG:?}"

# endpoint is the last arg; pick up the --jq expression if present
endpoint="${!#}"
jq_expr=""
prev=""
for a in "$@"; do
	[ "$prev" = "--jq" ] && jq_expr="$a"
	prev="$a"
done
path="${endpoint%%\?*}"
key="${path//\//_}"
resp="${FAKE_GH_FIXTURES:?}/$key"
if [ ! -f "$resp" ]; then
	echo "gh: no fixture for <$path>" >&2
	exit 1
fi
code=200
[ -f "$resp.code" ] && code="$(cat "$resp.code")"
case "$code" in
	204) exit 0 ;;
	404) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
	403) echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1 ;;
	401) echo "gh: Bad credentials (HTTP 401)" >&2; exit 1 ;;
	429) echo "gh: API rate limit exceeded for user ID 1. (HTTP 429)" >&2; exit 1 ;;
	net) echo "gh: failed to call the GitHub API: connection refused" >&2; exit 1 ;;
	*)
		body="$(cat "$resp")"
		case "$jq_expr" in
			*html_url*)
				# emulate `gh api --jq '.[].html_url'`: one html_url per line
				printf '%s' "$body" | grep -o '"html_url":"[^"]*"' | sed 's/"html_url":"//; s/"$//'
				;;
			*) printf '%s\n' "$body" ;;
		esac
		;;
esac
EOF
chmod +x "$SHIM/gh"
export PATH="$SHIM:$PATH"

# clear_fixtures — wipe all canned responses
clear_fixtures() { rm -f "$FIXTURES"/*; }

# fx <endpoint-path> <http-code|-> <body> — register a canned response.
# code "-" means 200 with the given body; empty body + "-" gives 200/empty.
fx() {
	local path="$1" code="$2" body="${3:-}"
	local key="${path//\//_}"
	if [ "$code" != "-" ]; then
		printf '%s' "$code" > "$FIXTURES/$key.code"
	else
		rm -f "$FIXTURES/$key.code"
	fi
	if [ -n "$body" ]; then
		printf '%s' "$body" > "$FIXTURES/$key"
	else
		: > "$FIXTURES/$key"
	fi
}

# happy fixtures: all four features enabled, zero open alerts
happy() {
	clear_fixtures
	fx "repos/acme/widget/vulnerability-alerts" 204
	fx "repos/acme/widget/automated-security-fixes" 204
	fx "repos/acme/widget/dependabot/alerts" - '[]'
	fx "repos/acme/widget/code-scanning/alerts" - '[]'
	fx "repos/acme/widget/secret-scanning/alerts" - '[]'
}

# run_check <expected-exit> <description> [env assignments...]
# Runs the real script with REPO/GH_TOKEN defaults; env overrides allowed.
run_check() {
	local expected="$1"; shift
	local desc="$1"; shift
	set +e
	env FAKE_GH_LOG="$LOG" FAKE_GH_FIXTURES="$FIXTURES" REPO="acme/widget" GH_TOKEN="test-token" \
		"$@" bash "$SCRIPT" > "$OUT" 2> "$ERR"
	local got=$?
	set -e
	if [ "$got" -eq "$expected" ]; then
		pass "$desc"
	else
		fail "$desc (exit $got, want $expected; stderr: $(head -c 300 "$ERR" | tr '\n' ' '))"
	fi
}

trap 'rm -rf "$TMP"' EXIT

echo "== Phase 1: happy path + env contract (stubbed gh, no network) =="

happy
: > "$LOG"
run_check 0 "happy: all features enabled, zero alerts -> exit 0"
assert_grep "✅ Dependabot enabled, 0 open alerts" "$OUT" "happy: dependabot reports enabled, 0 open alerts"
assert_grep "✅ Code scanning enabled, 0 open alerts" "$OUT" "happy: code scanning reports enabled, 0 open alerts"
assert_grep "✅ Secret scanning enabled, 0 open alerts" "$OUT" "happy: secret scanning reports enabled, 0 open alerts"
assert_grep_x "PASS" "$OUT" "happy: final PASS summary line"
assert_grep_v "  - " "$OUT" "happy: no alert links printed when zero alerts"

# REPO override respected: every probed endpoint references repos/<REPO>/...
assert_grep "repos/acme/widget/vulnerability-alerts" "$LOG" "endpoints: vulnerability-alerts probed with REPO"
assert_grep "repos/acme/widget/automated-security-fixes" "$LOG" "endpoints: automated-security-fixes probed with REPO"
assert_grep "repos/acme/widget/dependabot/alerts?state=open&per_page=100" "$LOG" "endpoints: dependabot alerts use state=open&per_page=100"
assert_grep "repos/acme/widget/code-scanning/alerts?state=open&per_page=100" "$LOG" "endpoints: code-scanning alerts use state=open&per_page=100"
assert_grep "repos/acme/widget/secret-scanning/alerts?state=open&per_page=100" "$LOG" "endpoints: secret-scanning alerts use state=open&per_page=100"
assert_grep "--paginate" "$LOG" "endpoints: --paginate used on alert endpoints"
assert_grep "<.[].html_url>" "$LOG" "endpoints: --jq expression extracts html_url"
assert_grep "GH_TOKEN=<test-token>" "$LOG" "endpoints: GH_TOKEN forwarded on every gh invocation"

# REPO unset -> falls back to $GITHUB_REPOSITORY
happy
set +e
env -u REPO FAKE_GH_LOG="$LOG" FAKE_GH_FIXTURES="$FIXTURES" GITHUB_REPOSITORY="acme/widget" GH_TOKEN="test-token" \
	bash "$SCRIPT" > "$OUT" 2> "$ERR"
got=$?
set -e
if [ "$got" -eq 0 ] && grep -Fq "repos/acme/widget/vulnerability-alerts" "$LOG"; then
	pass "REPO unset: falls back to \$GITHUB_REPOSITORY"
else
	fail "REPO unset: no GITHUB_REPOSITORY fallback (exit $got)"
fi

# GH_TOKEN unset -> defaults to $GITHUB_TOKEN
happy
: > "$LOG"
set +e
env -u GH_TOKEN FAKE_GH_LOG="$LOG" FAKE_GH_FIXTURES="$FIXTURES" REPO="acme/widget" GITHUB_TOKEN="fallback-token" \
	bash "$SCRIPT" > "$OUT" 2> "$ERR"
got=$?
set -e
if [ "$got" -eq 0 ] && grep -Fq "GH_TOKEN=<fallback-token>" "$LOG"; then
	pass "GH_TOKEN unset: defaults to \$GITHUB_TOKEN"
else
	fail "GH_TOKEN unset: no \$GITHUB_TOKEN fallback (exit $got)"
fi

# header documents exit-code + env contract
assert_grep "Exit codes" "$SCRIPT" "header: exit-code contract documented"
assert_grep "0  PASS" "$SCRIPT" "header: exit 0 PASS documented"
assert_grep "1  FAIL" "$SCRIPT" "header: exit 1 FAIL documented"
assert_grep "2  ERROR" "$SCRIPT" "header: exit 2 ERROR documented"
for v in REPO GH_TOKEN MALWARE_MODE ALERT_LINKS; do
	assert_grep "$v" "$SCRIPT" "header: env var $v documented"
done

# set -uo pipefail + syntax check
if grep -q 'set -uo pipefail' "$SCRIPT"; then
	pass "script: set -uo pipefail present"
else
	fail "script: set -uo pipefail missing"
fi
if bash -n "$SCRIPT"; then
	pass "script: passes bash -n syntax check"
else
	fail "script: bash -n syntax check failed"
fi

echo "== Phase 2: posture violations -> exit 1 =="

# dependabot: vulnerability-alerts 404
happy
fx "repos/acme/widget/vulnerability-alerts" 404
run_check 1 "dependabot: vulnerability-alerts 404 -> exit 1"
assert_grep_x "❌ Dependabot is NOT enabled on acme/widget." "$OUT" "dependabot disabled: canonical not-enabled line"
assert_grep "Enable it under Settings → Code security and analysis." "$OUT" "dependabot disabled: settings guidance present"
assert_grep "https://github.com/acme/widget/settings/security_analysis" "$OUT" "dependabot disabled: settings link present"
assert_grep "✅ Code scanning enabled, 0 open alerts" "$OUT" "aggregate: remaining features still checked after violation"
assert_grep_x "FAIL" "$OUT" "dependabot disabled: FAIL summary line"

# dependabot: vulnerability-alerts 204 but automated-security-fixes 404
happy
fx "repos/acme/widget/automated-security-fixes" 404
run_check 1 "dependabot: automated-security-fixes 404 -> exit 1 (both probes must pass)"
assert_grep "Dependabot is NOT enabled" "$OUT" "dependabot half-enabled: NOT enabled reported"

# dependabot: automated-security-fixes returns 200 with enabled:false body
# (real gh api shape — align shim fixtures with live API output)
happy
fx "repos/acme/widget/automated-security-fixes" - '{"enabled":false,"paused":false}'
run_check 1 "dependabot: automated-security-fixes enabled:false -> exit 1"
assert_grep "Dependabot is NOT enabled" "$OUT" "dependabot auto-fixes disabled body: NOT enabled reported"

# dependabot: automated-security-fixes 200 with enabled:true body -> enabled
happy
fx "repos/acme/widget/automated-security-fixes" - '{"enabled":true,"paused":false}'
run_check 0 "dependabot: automated-security-fixes enabled:true -> exit 0"
assert_grep "✅ Dependabot enabled, 0 open alerts" "$OUT" "dependabot auto-fixes enabled body: enabled reported"

# code scanning 404 (disabled OR configured-but-never-ran)
happy
fx "repos/acme/widget/code-scanning/alerts" 404
run_check 1 "code-scanning: alerts 404 -> exit 1"
assert_grep_x "❌ Code scanning is NOT enabled on acme/widget." "$OUT" "code-scanning disabled: canonical not-enabled line"
assert_grep "https://github.com/acme/widget/settings/security_analysis" "$OUT" "code-scanning disabled: settings link present"

# secret scanning 404
happy
fx "repos/acme/widget/secret-scanning/alerts" 404
run_check 1 "secret-scanning: alerts 404 -> exit 1"
assert_grep "❌ Secret scanning is NOT enabled on acme/widget." "$OUT" "secret-scanning disabled: canonical not-enabled line"
assert_grep "https://github.com/acme/widget/settings/security_analysis" "$OUT" "secret-scanning disabled: settings link present"

# dependabot with 3 open alerts
happy
fx "repos/acme/widget/dependabot/alerts" - '[{"html_url":"https://github.com/acme/widget/security/dependabot/1"},{"html_url":"https://github.com/acme/widget/security/dependabot/2"},{"html_url":"https://github.com/acme/widget/security/dependabot/3"}]'
run_check 1 "dependabot: 3 open alerts -> exit 1"
assert_grep_x "❌ Dependabot has 3 open alerts on acme/widget." "$OUT" "dependabot alerts: canonical open-alerts line"
assert_grep "Review: https://github.com/acme/widget/security/dependabot" "$OUT" "dependabot alerts: review link present"
assert_grep "  - https://github.com/acme/widget/security/dependabot/3" "$OUT" "dependabot alerts: html_url links listed (default max 5)"
if [ "$(count "  - " "$OUT")" -eq 3 ]; then
	pass "dependabot alerts: exactly 3 links printed"
else
	fail "dependabot alerts: expected 3 links, got $(count "  - " "$OUT")"
fi

# code scanning with 2 open alerts (paginated count)
happy
fx "repos/acme/widget/code-scanning/alerts" - '[{"html_url":"https://github.com/acme/widget/security/code-scanning/9"},{"html_url":"https://github.com/acme/widget/security/code-scanning/10"}]'
run_check 1 "code-scanning: 2 open alerts -> exit 1"
assert_grep_x "❌ Code scanning has 2 open alerts on acme/widget." "$OUT" "code-scanning alerts: canonical open-alerts line"
assert_grep "Review: https://github.com/acme/widget/security/code-scanning" "$OUT" "code-scanning alerts: review link present"

# secret scanning with 1 open alert
happy
fx "repos/acme/widget/secret-scanning/alerts" - '[{"html_url":"https://github.com/acme/widget/security/secret-scanning/42"}]'
run_check 1 "secret-scanning: 1 open alert -> exit 1"
assert_grep "❌ Secret scanning has 1 open alert on acme/widget." "$OUT" "secret-scanning alerts: canonical open-alerts line"
assert_grep "Review: https://github.com/acme/widget/security/secret-scanning" "$OUT" "secret-scanning alerts: review link present"

# multiple simultaneous violations — ALL reported, single FAIL, exit 1
happy
fx "repos/acme/widget/vulnerability-alerts" 404
fx "repos/acme/widget/code-scanning/alerts" - '[{"html_url":"https://github.com/acme/widget/security/code-scanning/1"},{"html_url":"https://github.com/acme/widget/security/code-scanning/2"},{"html_url":"https://github.com/acme/widget/security/code-scanning/3"}]'
fx "repos/acme/widget/secret-scanning/alerts" 404
run_check 1 "multi-violation: all violations reported, exit 1"
assert_grep "Dependabot is NOT enabled" "$OUT" "multi-violation: dependabot violation reported"
assert_grep "Code scanning has 3 open alerts" "$OUT" "multi-violation: code-scanning violation reported"
assert_grep "Secret scanning is NOT enabled" "$OUT" "multi-violation: secret-scanning violation reported"
assert_grep_x "FAIL" "$OUT" "multi-violation: single FAIL summary line"
if [ "$(count "^FAIL$" "$OUT")" -eq 1 ]; then
	pass "multi-violation: exactly one FAIL summary line"
else
	fail "multi-violation: expected 1 FAIL line, got $(grep -c '^FAIL$' "$OUT" || true)"
fi

echo "== Phase 3: check infrastructure failures -> exit 2 =="

# 403 -> token lacks security_events
happy
fx "repos/acme/widget/vulnerability-alerts" 403
run_check 2 "403: token lacks security_events -> exit 2"
assert_grep "security-events: read" "$ERR" "403: instructs adding security-events: read permission"
assert_grep "CHEASEE_PI_SECURITY_TOKEN" "$ERR" "403: suggests dedicated PAT secret"
assert_grep_x "ERROR" "$OUT" "403: ERROR summary line"

# 429 rate limit
happy
fx "repos/acme/widget/vulnerability-alerts" 429
run_check 2 "429: rate limit -> exit 2"
assert_grep "rate limit" "$ERR" "429: rate-limit message"
assert_grep_x "ERROR" "$OUT" "429: ERROR summary line"

# network error / status code not parseable
happy
fx "repos/acme/widget/vulnerability-alerts" net
run_check 2 "network error: unparseable status -> exit 2 (fail closed)"
assert_grep_x "ERROR" "$OUT" "network error: ERROR summary line"

# gh missing from PATH (nobin dir carries only bash, no gh)
mkdir -p "$TMP/nobin"
ln -sf "$(command -v bash)" "$TMP/nobin/bash"
set +e
env FAKE_GH_LOG="$LOG" FAKE_GH_FIXTURES="$FIXTURES" REPO="acme/widget" GH_TOKEN="test-token" \
	PATH="$TMP/nobin" bash "$SCRIPT" > "$OUT" 2> "$ERR"
got=$?
set -e
if [ "$got" -eq 2 ] && grep -Fq "gh" "$ERR"; then
	pass "gh missing: exit 2 with clear message"
else
	fail "gh missing: exit $got, stderr=$(head -c 200 "$ERR" | tr '\n' ' ')"
fi
assert_grep_x "ERROR" "$OUT" "gh missing: ERROR summary line"

# REPO unset AND GITHUB_REPOSITORY unset
set +e
env -u REPO -u GITHUB_REPOSITORY FAKE_GH_LOG="$LOG" FAKE_GH_FIXTURES="$FIXTURES" GH_TOKEN="test-token" \
	bash "$SCRIPT" > "$OUT" 2> "$ERR"
got=$?
set -e
if [ "$got" -eq 2 ]; then
	pass "REPO+env missing: exit 2 (fail closed)"
else
	fail "REPO+env missing: exit $got, want 2"
fi
assert_grep_x "ERROR" "$OUT" "REPO+env missing: ERROR summary line"

# empty REPO string
set +e
env -u GITHUB_REPOSITORY REPO="" FAKE_GH_LOG="$LOG" FAKE_GH_FIXTURES="$FIXTURES" GH_TOKEN="test-token" \
	bash "$SCRIPT" > "$OUT" 2> "$ERR"
got=$?
set -e
if [ "$got" -eq 2 ]; then
	pass "empty REPO: exit 2 (fail closed)"
else
	fail "empty REPO: exit $got, want 2"
fi
assert_grep_x "ERROR" "$OUT" "empty REPO: ERROR summary line"

echo "== Phase 4: malware mode + alert-link boundaries =="

# default MALWARE_MODE=warn: non-blocking notice, exit 0
happy
run_check 0 "malware: default warn mode non-blocking -> exit 0"
assert_grep "⚠️" "$OUT" "malware warn: ⚠️ notice present"
assert_grep "https://github.com/acme/widget/security/malware" "$OUT" "malware warn: /security/malware link present"
assert_grep_x "PASS" "$OUT" "malware warn: PASS summary line"

# MALWARE_MODE=strict: fail closed, exit 2
happy
run_check 2 "malware: strict mode fails closed -> exit 2" MALWARE_MODE=strict
assert_grep "cannot verify via API" "$OUT" "malware strict: cannot-verify message present"
assert_grep "https://github.com/acme/widget/security/malware" "$OUT" "malware strict: /security/malware link present"
assert_grep_x "ERROR" "$OUT" "malware strict: ERROR summary line"

# ALERT_LINKS=1 prints only 1 link
happy
fx "repos/acme/widget/dependabot/alerts" - '[{"html_url":"https://github.com/acme/widget/security/dependabot/1"},{"html_url":"https://github.com/acme/widget/security/dependabot/2"},{"html_url":"https://github.com/acme/widget/security/dependabot/3"}]'
run_check 1 "ALERT_LINKS=1: caps links at 1" ALERT_LINKS=1
if [ "$(count "  - " "$OUT")" -eq 1 ]; then
	pass "ALERT_LINKS=1: exactly 1 link printed"
else
	fail "ALERT_LINKS=1: expected 1 link, got $(count "  - " "$OUT")"
fi

# default ALERT_LINKS=5 caps at 5 when open alerts exceed the limit
happy
fx "repos/acme/widget/secret-scanning/alerts" - '[{"html_url":"https://github.com/acme/widget/security/secret-scanning/1"},{"html_url":"https://github.com/acme/widget/security/secret-scanning/2"},{"html_url":"https://github.com/acme/widget/security/secret-scanning/3"},{"html_url":"https://github.com/acme/widget/security/secret-scanning/4"},{"html_url":"https://github.com/acme/widget/security/secret-scanning/5"},{"html_url":"https://github.com/acme/widget/security/secret-scanning/6"},{"html_url":"https://github.com/acme/widget/security/secret-scanning/7"}]'
run_check 1 "default ALERT_LINKS=5: caps at 5 when 7 open alerts" 
if [ "$(count "  - " "$OUT")" -eq 5 ]; then
	pass "default ALERT_LINKS: exactly 5 links printed"
else
	fail "default ALERT_LINKS: expected 5 links, got $(count "  - " "$OUT")"
fi
assert_grep "❌ Secret scanning has 7 open alerts on acme/widget." "$OUT" "default ALERT_LINKS: count still 7 in headline"

# 200 with empty JSON array -> enabled, 0 open alerts (asserted in Phase 1 happy run)

echo "== Phase 5: workflow wiring =="

if [ -f "$WF" ]; then pass "workflow: security-posture.yml exists"; else fail "workflow: security-posture.yml missing"; fi
if grep -q 'pull_request:' "$WF" 2>/dev/null; then pass "workflow: pull_request trigger present (unfiltered enforcement)"; else fail "workflow: pull_request trigger missing"; fi
if grep -q 'push:' "$WF" 2>/dev/null && grep -q '"main"' "$WF" 2>/dev/null; then pass "workflow: push to main trigger present"; else fail "workflow: push-to-main trigger missing"; fi
if grep -q 'schedule:' "$WF" 2>/dev/null && grep -q 'cron:' "$WF" 2>/dev/null; then pass "workflow: nightly schedule trigger present"; else fail "workflow: schedule trigger missing"; fi
if grep -q 'workflow_dispatch:' "$WF" 2>/dev/null; then pass "workflow: workflow_dispatch present (manual recovery)"; else fail "workflow: workflow_dispatch missing"; fi
if grep -q 'security-events: read' "$WF" 2>/dev/null && grep -q 'contents: read' "$WF" 2>/dev/null; then pass "workflow: permissions contents: read + security-events: read"; else fail "workflow: permissions block incomplete"; fi
if grep -Fq 'GH_TOKEN: ${{ secrets.CHEASEE_PI_SECURITY_TOKEN || github.token }}' "$WF" 2>/dev/null; then pass "workflow: token selection PAT fallback"; else fail "workflow: GH_TOKEN selection missing PAT fallback"; fi
if grep -q 'bash test/security-posture.test.sh' "$WF" 2>/dev/null; then pass "workflow: contract test step present"; else fail "workflow: contract test step missing"; fi
if grep -Fq 'REPO: ${{ github.repository }}' "$WF" 2>/dev/null; then pass "workflow: REPO derived from github.repository"; else fail "workflow: REPO env missing"; fi
if grep -q 'actions/checkout@v5' "$WF" 2>/dev/null; then pass "workflow: checkout@v5 (repo convention)"; else fail "workflow: checkout step missing"; fi
if grep -q 'timeout-minutes: 5' "$WF" 2>/dev/null; then pass "workflow: timeout-minutes 5"; else fail "workflow: timeout-minutes missing/not 5"; fi
if grep -q 'concurrency:' "$WF" 2>/dev/null && grep -q 'cancel-in-progress' "$WF" 2>/dev/null; then pass "workflow: concurrency group + cancel-in-progress"; else fail "workflow: concurrency block missing"; fi
if grep -q 'continue-on-error' "$WF" 2>/dev/null; then fail "workflow: continue-on-error present (must block)"; else pass "workflow: no continue-on-error (violations block PR)"; fi
# step order: checkout must precede test step, test step must precede check step
if awk '/actions\/checkout/{c=NR} /test\/security-posture\.test\.sh/{t=NR} /check-security-posture\.sh/{s=NR} END{exit !(c && t && s && c<t && t<s)}' "$WF" 2>/dev/null; then
	pass "workflow: step order checkout -> contract test -> posture check"
else
	fail "workflow: step order wrong or step missing"
fi

# regression: existing workflows untouched (only new workflow files allowed)
base="$(git merge-base HEAD origin/main 2>/dev/null || true)"
if statuses="$(git diff --name-status "$base" HEAD -- .github/workflows/ 2>/dev/null)"; then
	modified="$(printf '%s\n' "$statuses" | grep -v '^A' || true)"
	if [ -z "$modified" ]; then
		pass "regression: existing workflows unmodified (only new workflow files)"
	else
		fail "regression: existing workflows modified: $(printf '%s ' $modified)"
	fi
fi

echo "== Phase 6: docs =="

DOCS="docs/security.md"
if grep -q "CI security posture check" "$DOCS" 2>/dev/null; then
	assert_grep "Exit codes" "$DOCS" "docs: exit-code contract documented"
	assert_grep "MALWARE_MODE" "$DOCS" "docs: MALWARE_MODE documented"
	assert_grep "ALERT_LINKS" "$DOCS" "docs: ALERT_LINKS documented"
	assert_grep "REPO" "$DOCS" "docs: REPO env documented"
	assert_grep "/security/code-scanning" "$DOCS" "docs: /security/* links documented"
else
	fail "docs: CI security posture check section missing"
fi

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
