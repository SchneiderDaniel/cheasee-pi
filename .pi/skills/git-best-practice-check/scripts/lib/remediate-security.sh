#!/usr/bin/env bash
# remediate-security.sh — the single write per security practice.
#
# Each GitHub feature has its own transport: alerts have a dedicated endpoint,
# secret scanning rides on the repo object, code scanning default setup is
# PATCHed and then onboarded asynchronously.

remediate_dependabot_alerts() {
	local response
	STEP="write-dependabot-alerts"
	response=$(gh_request PUT "/repos/$REPO/vulnerability-alerts")
	require_success "enable dependabot alerts" "$response"
}

remediate_secret_scanning() {
	local response
	# There is no PUT on a secret-scanning settings path: the status lives in
	# the repo object's security_and_analysis block.
	STEP="write-secret-scanning"
	response=$(gh_request PATCH "/repos/$REPO" '{"security_and_analysis":{"secret_scanning":{"status":"enabled"}}}')
	require_success "enable secret scanning" "$response"
}

remediate_code_scanning() {
	local response attempt attempts interval state
	STEP="write-code-scanning"
	response=$(gh_request PATCH "/repos/$REPO/code-scanning/default-setup" '{"state":"configured","query_suite":"default"}')
	require_success "enable code scanning default setup" "$response"

	# Onboarding is asynchronous: the PATCH can answer 2xx while default setup
	# still reads not-configured. Poll a bounded number of times, then report
	# pending rather than inventing a pass or a fail.
	STEP="poll-code-scanning"
	attempts="${GBPC_POLL_ATTEMPTS:-5}"
	interval="${GBPC_POLL_INTERVAL:-2}"
	state=""
	for ((attempt = 1; attempt <= attempts; attempt++)); do
		state=$(jq -r '.body.state // ""' <<<"$(gh_request GET "/repos/$REPO/code-scanning/default-setup")")
		if [[ "$state" == "configured" ]]; then
			break
		fi
		if [[ "$interval" != "0" ]]; then
			sleep "$interval"
		fi
	done

	if [[ "$state" != "configured" ]]; then
		printf '%s: fail → pending (default setup requested, still "%s" after %s polls; re-run the audit once GitHub finishes onboarding)\n' \
			"$ID" "${state:-unknown}" "$attempts"
		SKIP_VERIFY=1
	fi
}
