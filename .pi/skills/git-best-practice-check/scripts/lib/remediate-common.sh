#!/usr/bin/env bash
# remediate-common.sh — helpers shared by the remediation modules.

# require_success <description> <gateway-response>
# Prints the API status and body on a non-2xx answer and fails, so a rejected
# write is never reported as applied.
require_success() {
	local description="$1" response="$2" status
	if ! status=$(response_status "$response"); then
		printf 'remediate: %s failed (the gateway returned no HTTP status)\n' "$description" >&2
		return 1
	fi
	if [[ "$status" =~ ^2[0-9][0-9]$ ]]; then
		return 0
	fi
	printf 'remediate: %s failed (HTTP %s): %s\n' "$description" "$status" "$(response_body "$response")" >&2
	return 1
}

# license_body — GET /licenses/{key} then substitute the [year] and [fullname]
# placeholders. Uses GitHub's own template text instead of a hand-written one.
license_body() {
	local template status body year
	template=$(gh_request GET "/licenses/$LICENSE_KEY")
	if ! status=$(response_status "$template"); then
		printf 'remediate: unexpected gateway response for GET /licenses/%s\n' "$LICENSE_KEY" >&2
		return 1
	fi
	if [[ "$status" != "200" ]]; then
		printf 'remediate: cannot fetch the "%s" license template (HTTP %s)\n' "$LICENSE_KEY" "$status" >&2
		return 1
	fi
	if ! body=$(jq -r '.body.body // ""' <<<"$template"); then
		printf 'remediate: cannot read the "%s" license template body\n' "$LICENSE_KEY" >&2
		return 1
	fi
	if [[ -z "$body" ]]; then
		printf 'remediate: license template "%s" carries no body\n' "$LICENSE_KEY" >&2
		return 1
	fi
	year=$(date -u +%Y)
	body=${body//\[year\]/$year}
	body=${body//\[fullname\]/$FULLNAME}
	printf '%s' "$body"
}
