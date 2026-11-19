#!/usr/bin/env bash
# evidence.sh — read-only evidence gathering for audit.sh.
#
# Every request goes through lib/gateway.sh, so the GET-only guarantee holds in
# one place. `$REPO` and `$DEFAULT_BRANCH` are supplied by audit.sh.

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
	local id="$1" profile probes='[]' path resp
	# A fork has no community profile (404); the evidence bundle carries the
	# status through so evaluate.jq can fall back to the contents probes.
	profile=$(gh_request GET "/repos/$REPO/community/profile")
	while IFS= read -r path; do
		resp=$(gh_request GET "/repos/$REPO/contents/$path")
		probes=$(jq -c --arg p "$path" --argjson r "$resp" '. + [{path: $p, status: $r.status, body: $r.body}]' <<<"$probes")
	done < <(community_probe_paths "$id")
	jq -c -n --arg slug "$REPO" --arg branch "$DEFAULT_BRANCH" \
		--argjson profile "$profile" --argjson probes "$probes" \
		'{slug: $slug, default_branch: $branch, profile: $profile, probes: $probes}'
}

gather_evidence() {
	case "$1" in
	branch-protection)
		local protection rules
		protection=$(gh_request GET "/repos/$REPO/branches/$DEFAULT_BRANCH/protection")
		rules=$(gh_request GET "/repos/$REPO/rules/branches/$DEFAULT_BRANCH")
		jq -c -n --arg slug "$REPO" --arg branch "$DEFAULT_BRANCH" \
			--argjson protection "$protection" --argjson rules "$rules" \
			'{slug: $slug, default_branch: $branch, protection: $protection, rules: $rules}'
		;;
	dependabot-alerts)
		local alerts
		alerts=$(gh_request GET "/repos/$REPO/vulnerability-alerts")
		jq -c -n --arg slug "$REPO" --arg branch "$DEFAULT_BRANCH" --argjson alerts "$alerts" \
			'{slug: $slug, default_branch: $branch, vulnerability_alerts: $alerts}'
		;;
	secret-scanning)
		# Fetched per check so `--check secret-scanning` gathers its own
		# evidence: 401/403 on this path is the only "not available on plan" signal.
		local payload
		payload=$(gh_request GET "/repos/$REPO")
		jq -c -n --arg slug "$REPO" --arg branch "$DEFAULT_BRANCH" --argjson payload "$payload" \
			'{slug: $slug, default_branch: $branch, repo: $payload}'
		;;
	code-scanning)
		local setup analyses
		setup=$(gh_request GET "/repos/$REPO/code-scanning/default-setup")
		analyses=$(gh_request GET "/repos/$REPO/code-scanning/analyses")
		jq -c -n --arg slug "$REPO" --arg branch "$DEFAULT_BRANCH" \
			--argjson setup "$setup" --argjson analyses "$analyses" \
			'{slug: $slug, default_branch: $branch, default_setup: $setup, analyses: $analyses}'
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
