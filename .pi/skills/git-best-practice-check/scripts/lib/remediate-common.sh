#!/usr/bin/env bash
# remediate-common.sh — helpers shared by the remediation modules.

# require_success <description> <gateway-response>
# Prints the API status and body on a non-2xx answer and fails, so a rejected
# write is never reported as applied.
require_success() {
	local description="$1" response="$2" status
	status=$(jq -r '.status' <<<"$response")
	if [[ "$status" =~ ^2[0-9][0-9]$ ]]; then
		return 0
	fi
	printf 'remediate: %s failed (HTTP %s): %s\n' "$description" "$status" "$(jq -c '.body' <<<"$response")" >&2
	return 1
}

# license_body — GET /licenses/{key} then substitute the [year] and [fullname]
# placeholders. Uses GitHub's own template text instead of a hand-written one.
license_body() {
	local template body year
	template=$(gh_request GET "/licenses/$LICENSE_KEY")
	if [[ "$(jq -r '.status' <<<"$template")" != "200" ]]; then
		printf 'remediate: cannot fetch the "%s" license template (HTTP %s)\n' "$LICENSE_KEY" "$(jq -r '.status' <<<"$template")" >&2
		return 1
	fi
	body=$(jq -r '.body.body // ""' <<<"$template")
	if [[ -z "$body" ]]; then
		printf 'remediate: license template "%s" carries no body\n' "$LICENSE_KEY" >&2
		return 1
	fi
	year=$(date -u +%Y)
	body=${body//\[year\]/$year}
	body=${body//\[fullname\]/$FULLNAME}
	printf '%s' "$body"
}
