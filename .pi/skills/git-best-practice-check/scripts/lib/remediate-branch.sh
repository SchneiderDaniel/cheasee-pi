#!/usr/bin/env bash
# remediate-branch.sh — the single write for `branch-protection`.
#
# The body comes from lib/branch-protection.jq: a read-modify-write of the live
# config, because the endpoint replaces the whole protection object.

BRANCH_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

remediate_branch_protection() {
	local current current_body payload response branch_path
	# One path segment: a branch named "release/2026" must be encoded, or the
	# request addresses a different path and GitHub answers 404.
	branch_path=$(urlencode_path_component "$DEFAULT_BRANCH")
	current=$(gh_request GET "/repos/$REPO/branches/$branch_path/protection")
	current_body='{}'
	if [[ "$(jq -r '.status' <<<"$current")" == "200" ]]; then
		current_body=$(jq -c '.body' <<<"$current")
	fi
	payload=$(jq -c -n -f "$BRANCH_LIB_DIR/branch-protection.jq" --argjson current "$current_body")
	STEP="write-branch-protection"
	response=$(gh_request PUT "/repos/$REPO/branches/$branch_path/protection" "$payload")
	require_success "protect $DEFAULT_BRANCH (1+ approving review, admins enforced)" "$response"
}
