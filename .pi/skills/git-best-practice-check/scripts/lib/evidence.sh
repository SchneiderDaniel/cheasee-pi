#!/usr/bin/env bash
# evidence.sh — read-only evidence gathering for audit.sh.
#
# Every request goes through lib/gateway.sh, so the GET-only guarantee holds in
# one place. `$REPO` and `$DEFAULT_BRANCH` are supplied by audit.sh.
#
# Bundles are assembled with printf from the (already compact) gateway
# responses: re-parsing them with jq would add a subprocess per request and
# change nothing, because the gateway output is JSON by contract.

# id -> community/profile files.* field, loaded from the rules on demand.
declare -A COMMUNITY_FIELD=()

community_probe_paths() {
	case "$1" in
	community-readme) printf '%s\n' "README.md" "docs/README.md" ;;
	community-code-of-conduct) printf '%s\n' "CODE_OF_CONDUCT.md" ".github/CODE_OF_CONDUCT.md" "docs/CODE_OF_CONDUCT.md" ;;
	community-contributing) printf '%s\n' "CONTRIBUTING.md" ".github/CONTRIBUTING.md" "docs/CONTRIBUTING.md" ;;
	community-license) printf '%s\n' "LICENSE" "LICENSE.md" "COPYING" ;;
	community-security-policy) printf '%s\n' "SECURITY.md" ".github/SECURITY.md" "docs/SECURITY.md" ;;
	community-issue-templates) printf '%s\n' ".github/ISSUE_TEMPLATE" ;;
	community-pull-request-template) printf '%s\n' ".github/PULL_REQUEST_TEMPLATE.md" "PULL_REQUEST_TEMPLATE.md" "docs/PULL_REQUEST_TEMPLATE.md" ;;
	*)
		printf 'audit: no contents probes defined for "%s"\n' "$1" >&2
		return 64
		;;
	esac
}

gather_community() {
	local id="$1" field="${COMMUNITY_FIELD[$1]:-}" probes="[" separator="" path response status body path_json
	# One profile read per process: an audit of the whole checklist gathers
	# seven community checks, and all seven describe the same profile document.
	if [[ -z "${GBPC_COMMUNITY_PROFILE:-}" ]]; then
		GBPC_COMMUNITY_PROFILE=$(gh_request GET "/repos/$REPO/community/profile")
	fi
	# The profile is the primary source for the six practices it reports. The
	# contents probes exist for the practice it does not report (the security
	# policy) and for what it cannot answer: a fork with no profile, or a field it
	# leaves null (a README at a non-standard path, a symlink). Probing anyway
	# would spend up to three requests per practice on evidence the rules never
	# prefer over the profile.
	local probes_needed=1
	if [[ -n "$field" ]]; then
		if jq -e --arg f "$field" '((.body // {}).files // {})[$f] != null' <<<"$GBPC_COMMUNITY_PROFILE" >/dev/null 2>&1; then
			probes_needed=0
		fi
	fi
	if ((probes_needed)); then
		# A fork has no community profile (404); the evidence bundle carries the
		# status through so evaluate.jq can fall back to the contents probes.
		while IFS= read -r path; do
			response=$(gh_request GET "/repos/$REPO/contents/$path")
			status=$(response_status "$response") || {
				printf 'audit: unexpected gateway response for contents/%s\n' "$path" >&2
				return 1
			}
			body=$(response_body "$response") || {
				printf 'audit: unexpected gateway response for contents/%s\n' "$path" >&2
				return 1
			}
			json_quote path_json "$path"
			probes+="${separator}{\"path\":${path_json},\"status\":${status},\"body\":${body}}"
			separator=","
		done < <(community_probe_paths "$id")
	fi
	probes+="]"

	local slug branch_name
	json_quote slug "$REPO"
	json_quote branch_name "$DEFAULT_BRANCH"
	printf '{"slug":%s,"default_branch":%s,"profile":%s,"probes":%s}' \
		"$slug" "$branch_name" "$GBPC_COMMUNITY_PROFILE" "$probes"
}

# community_field_map — load id -> community/profile files.* field from the
# rules, so the gatherer knows which practice the profile can answer without
# duplicating the mapping in a second place.
community_field_map() {
	local id field
	while IFS=$'\t' read -r id field; do
		[[ -z "$id" ]] && continue
		COMMUNITY_FIELD["$id"]="$field"
	done < <(jq -n -r -f "$EVALUATE" --arg mode community-fields)
}

# ensure_community_profile <ids...> — read the profile once for the run, but
# only when at least one community practice is being audited.
ensure_community_profile() {
	local id
	for id in "$@"; do
		case "$id" in
		community-*) ;;
		*) continue ;;
		esac
		community_field_map
		GBPC_COMMUNITY_PROFILE=$(gh_request GET "/repos/$REPO/community/profile")
		return 0
	done
	return 0
}

gather_evidence() {
	case "$1" in
	branch-protection)
		local protection rules branch_path slug branch_name
		# The branch name is a single path segment: encode it, or a branch like
		# "release/2026" turns into a different request path and answers 404.
		branch_path=$(urlencode_path_component "$DEFAULT_BRANCH")
		protection=$(gh_request GET "/repos/$REPO/branches/$branch_path/protection")
		rules=$(gh_request GET "/repos/$REPO/rules/branches/$branch_path")
		json_quote slug "$REPO"
		json_quote branch_name "$DEFAULT_BRANCH"
		printf '{"slug":%s,"default_branch":%s,"protection":%s,"rules":%s}' \
			"$slug" "$branch_name" "$protection" "$rules"
		;;
	dependabot-alerts)
		local alerts slug branch_name
		alerts=$(gh_request GET "/repos/$REPO/vulnerability-alerts")
		json_quote slug "$REPO"
		json_quote branch_name "$DEFAULT_BRANCH"
		printf '{"slug":%s,"default_branch":%s,"vulnerability_alerts":%s}' \
			"$slug" "$branch_name" "$alerts"
		;;
	secret-scanning)
		# Fetched per check so `--check secret-scanning` gathers its own
		# evidence: 401/403 on this path is the only "not available on plan" signal.
		local payload slug branch_name
		payload=$(gh_request GET "/repos/$REPO")
		json_quote slug "$REPO"
		json_quote branch_name "$DEFAULT_BRANCH"
		printf '{"slug":%s,"default_branch":%s,"repo":%s}' "$slug" "$branch_name" "$payload"
		;;
	code-scanning)
		# Default setup answers whether scanning is on; analyses answers whether
		# it has ever run. Both statuses travel with the evidence so the rules
		# can tell "no scanner" from "cannot read the scanner".
		local setup analyses slug branch_name
		setup=$(gh_request GET "/repos/$REPO/code-scanning/default-setup")
		analyses=$(gh_request GET "/repos/$REPO/code-scanning/analyses")
		json_quote slug "$REPO"
		json_quote branch_name "$DEFAULT_BRANCH"
		printf '{"slug":%s,"default_branch":%s,"default_setup":%s,"analyses":%s}' \
			"$slug" "$branch_name" "$setup" "$analyses"
		;;
	community-*)
		gather_community "$1"
		;;
	*)
		printf 'audit: no evidence gatherer for "%s"\n' "$1" >&2
		return 64
		;;
	esac
}
