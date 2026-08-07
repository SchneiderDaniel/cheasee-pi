#!/usr/bin/env bash
# scripts/check-security-posture.sh
#
# CI check for GitHub-native security features: Dependabot, code
# scanning, secret scanning, malware scanning (issue #1470).
#
# Probes the GitHub REST API via `gh api` (no external deps; gh is
# preinstalled on ubuntu-latest runners) and fails the pipeline when a
# feature is disabled or has open alerts. Runs locally and on any CI —
# it is Actions-agnostic and only reads env vars.
#
# Environment contract:
#   REPO          owner/repo to check (default: $GITHUB_REPOSITORY)
#   GH_TOKEN      token for gh (default: $GITHUB_TOKEN). Alert APIs are
#                 gated on the `security_events` scope — use a dedicated
#                 PAT (e.g. CHEASEE_PI_SECURITY_TOKEN secret) if the
#                 workflow token 403s.
#   MALWARE_MODE  warn | strict (default: warn). Malware scanning has no
#                 public per-repo REST endpoint yet; warn prints a
#                 non-blocking notice + /security/malware link, strict
#                 fails closed (exit 2).
#   ALERT_LINKS   max alert links printed per feature (default: 5)
#
# Exit codes (documented contract — do not change):
#   0  PASS   — all four features enabled, zero open alerts
#   1  FAIL   — posture violation: feature NOT enabled or open alerts
#   2  ERROR  — check infrastructure failure: token lacks permissions,
#               rate limit, network error, gh missing, REPO
#               undeterminable. Never exit 0 on uncertainty (fail closed).

set -uo pipefail

# die <msg> — infra failure: message + ERROR summary, exit 2
die() {
	echo "ERROR: $1" >&2
	echo "ERROR"
	exit 2
}

# gh_call <endpoint> [gh api flags...]
# Runs gh api; captures stdout/stderr and the HTTP status code parsed
# from gh's stderr ("gh: Not Found (HTTP 404)"). Sets GH_RC, GH_OUT
# (file), GH_ERR (file), GH_HTTP, GH_ENDPOINT.
gh_call() {
	GH_ENDPOINT="$1"; shift
	GH_OUT="$(mktemp)"
	GH_ERR="$(mktemp)"
	GH_HTTP=""
	gh api "$@" "$GH_ENDPOINT" >"$GH_OUT" 2>"$GH_ERR"
	GH_RC=$?
	GH_HTTP="$(sed -n 's/.*HTTP \([0-9][0-9][0-9]\).*/\1/p' "$GH_ERR" | head -1)"
}

# classify_result — maps the last gh_call outcome:
#   0 = OK, 1 = NOT enabled (HTTP 404), 2 = infra error (sets ERROR_FLAG)
classify_result() {
	if [ "$GH_RC" -eq 0 ]; then
		return 0
	fi
	case "$GH_HTTP" in
		404)
			return 1
			;;
		403)
			infra_error "GitHub API returned HTTP 403 on $GH_ENDPOINT — token lacks the security_events scope. Add 'security-events: read' to the workflow permissions or set the CHEASEE_PI_SECURITY_TOKEN secret (dedicated PAT)."
			return 2
			;;
		401)
			infra_error "GitHub API rejected the token (HTTP 401) on $GH_ENDPOINT — check GH_TOKEN."
			return 2
			;;
		429)
			infra_error "GitHub API rate limit exceeded (HTTP 429) on $GH_ENDPOINT — retry later."
			return 2
			;;
		*)
			infra_error "unexpected gh api failure on $GH_ENDPOINT (exit $GH_RC): $(head -c 300 "$GH_ERR" | tr '\n' ' ')"
			return 2
			;;
	esac
}

# infra_error <msg> — record an infra failure (stderr), keep checking
infra_error() {
	echo "ERROR: $1" >&2
	ERROR_FLAG=1
}

# report_not_enabled <Feature> — posture violation: feature disabled
report_not_enabled() {
	echo "❌ $1 is NOT enabled on $REPO."
	echo "Enable it under Settings → Code security and analysis."
	echo "See https://github.com/$REPO/settings/security_analysis"
	POSTURE_VIOLATIONS=$((POSTURE_VIOLATIONS + 1))
}

# report_open_alerts <Feature> <page> <count> <links-file>
report_open_alerts() {
	local feature="$1" page="$2" count="$3" links="$4"
	local noun="alerts"
	[ "$count" -eq 1 ] && noun="alert"
	echo "❌ $feature has $count open $noun on $REPO."
	echo "Review: https://github.com/$REPO/security/$page"
	head -n "$ALERT_LINKS" "$links" | sed '/^$/d' | while IFS= read -r link; do
		echo "  - $link"
	done
	POSTURE_VIOLATIONS=$((POSTURE_VIOLATIONS + 1))
}

# check_dependabot — two enablement probes + open-alert count
check_dependabot() {
	local feature="Dependabot"

	gh_call "repos/$REPO/vulnerability-alerts"
	classify_result
	case $? in
		0) ;;
		1) report_not_enabled "$feature"; return ;;
		2) return ;;
	esac

	# 204 (empty) = enabled; 200 {"enabled":false} = disabled
	gh_call "repos/$REPO/automated-security-fixes"
	classify_result
	case $? in
		0)
			if grep -q '"enabled": *false' "$GH_OUT"; then
				report_not_enabled "$feature"
				return
			fi
			;;
		1) report_not_enabled "$feature"; return ;;
		2) return ;;
	esac

	gh_call "repos/$REPO/dependabot/alerts?state=open&per_page=100" --paginate --jq '.[].html_url'
	classify_result
	case $? in
		0)
			emit_alert_result "$feature" dependabot
			;;
		1) report_not_enabled "$feature" ;;
		2) return ;;
	esac
}

# check_scanning_feature <Feature> <api-path> <page>
# One endpoint serves as both the enablement probe and the open-alert
# count: 200 = enabled (array, possibly empty), 404 = disabled /
# configured-but-never-ran (same actionable message either way).
check_scanning_feature() {
	local feature="$1" api="$2" page="$3"

	gh_call "repos/$REPO/$api?state=open&per_page=100" --paginate --jq '.[].html_url'
	classify_result
	case $? in
		0) emit_alert_result "$feature" "$page" ;;
		1) report_not_enabled "$feature" ;;
		2) return ;;
	esac
}

# emit_alert_result <Feature> <page> — after a successful alerts fetch:
# 0 alerts -> enabled; N alerts -> violation with count + links
emit_alert_result() {
	local feature="$1" page="$2"
	local count
	count="$(grep -c . "$GH_OUT" || true)"
	if [ "$count" -eq 0 ]; then
		echo "✅ $feature enabled, 0 open alerts"
	else
		report_open_alerts "$feature" "$page" "$count" "$GH_OUT"
	fi
}

# check_malware — no public per-repo REST endpoint exists; the signal is
# the /security/malware page, which we link but never scrape.
check_malware() {
	if [ "$MALWARE_MODE" = "strict" ]; then
		echo "❌ Malware scanning: cannot verify via API (no public per-repo REST endpoint); MALWARE_MODE=strict, failing closed."
		echo "   See https://github.com/$REPO/security/malware"
		ERROR_FLAG=1
	else
		echo "⚠️ Malware scanning: cannot verify via API (no public per-repo REST endpoint); MALWARE_MODE=warn, non-blocking."
		echo "   See https://github.com/$REPO/security/malware"
	fi
}

main() {
	if [ -n "${REPO:-}" ]; then
		:
	elif [ -n "${GITHUB_REPOSITORY:-}" ]; then
		REPO="$GITHUB_REPOSITORY"
	else
		die "cannot determine repository — set REPO or GITHUB_REPOSITORY"
	fi

	if ! command -v gh >/dev/null 2>&1; then
		die "'gh' CLI not found in PATH — install GitHub CLI (https://cli.github.com)"
	fi

	GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
	export GH_TOKEN
	MALWARE_MODE="${MALWARE_MODE:-warn}"
	ALERT_LINKS="${ALERT_LINKS:-5}"

	POSTURE_VIOLATIONS=0
	ERROR_FLAG=0

	TMPDIR="$(mktemp -d)"
	export TMPDIR
	trap 'rm -rf "$TMPDIR"' EXIT

	check_dependabot
	check_scanning_feature "Code scanning" "code-scanning/alerts" "code-scanning"
	check_scanning_feature "Secret scanning" "secret-scanning/alerts" "secret-scanning"
	check_malware

	if [ "$ERROR_FLAG" -ne 0 ]; then
		echo "ERROR"
		exit 2
	fi
	if [ "$POSTURE_VIOLATIONS" -ne 0 ]; then
		echo "FAIL"
		exit 1
	fi
	echo "PASS"
	exit 0
}

main "$@"
