#!/usr/bin/env bash
# audit.sh — read-only evidence gathering for git-best-practice-check.
#
# usage: audit.sh [--repo owner/repo] [--check <id>] [--settings <path>] [--json]
#
# Every practice is gathered independently through the gateway, then handed to
# evaluate.jq for the pass/fail verdict. This script issues GET requests only.
#
# exit 0 — every check evaluated (fail rows are a normal outcome)
# exit 1 — at least one check is `unknown` (the report is still printed)
# exit 2 — preflight failed: the repo is unreadable or the token lacks admin
# exit 64 — bad invocation (unknown check id, unknown argument)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/gateway.sh
source "$SCRIPT_DIR/lib/gateway.sh"
# shellcheck source=lib/repo.sh
source "$SCRIPT_DIR/lib/repo.sh"

EVALUATE="$SCRIPT_DIR/evaluate.jq"

usage() {
	printf '%s\n' \
		'usage: audit.sh [--repo owner/repo] [--check <id>] [--settings <path>] [--json]' \
		'' \
		'Read-only audit of a GitHub repository against the git-best-practice-check' \
		'checklist. Default output is a table with one row per practice and the' \
		'evidence behind each verdict; --json prints the same rows as a JSON array.' \
		'Exits 1 when any practice could not be evaluated (status "unknown").'
}

JSON_OUT=0
CHECK_ID=""
REPO_ARG=""
SETTINGS=""

while (($# > 0)); do
	case "$1" in
	--json)
		JSON_OUT=1
		shift
		;;
	--check)
		CHECK_ID="${2:-}"
		shift 2
		;;
	--repo)
		REPO_ARG="${2:-}"
		shift 2
		;;
	--settings)
		SETTINGS="${2:-}"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		printf 'audit: unknown argument "%s"\n' "$1" >&2
		usage >&2
		exit 64
		;;
	esac
done

if [[ -n "$SETTINGS" ]]; then
	export GBPC_SETTINGS_FILE="$SETTINGS"
fi

mapfile -t ALL_IDS < <(jq -n -r -f "$EVALUATE" --arg mode list-ids)

if [[ -n "$CHECK_ID" ]]; then
	known=0
	for id in "${ALL_IDS[@]}"; do
		if [[ "$id" == "$CHECK_ID" ]]; then known=1; fi
	done
	if ((known == 0)); then
		printf 'audit: unknown check id "%s"; valid ids: %s\n' "$CHECK_ID" "${ALL_IDS[*]}" >&2
		exit 64
	fi
	IDS=("$CHECK_ID")
else
	IDS=("${ALL_IDS[@]}")
fi

if ! REPO=$(resolve_repo ${REPO_ARG:+"$REPO_ARG"}); then
	exit 2
fi

# --- preflight -------------------------------------------------------------
# Admin is required for branch protection and security settings. Separating a
# permission gap from a "practice failed" verdict keeps the audit from telling
# the user to fix something it simply cannot see.
preflight=$(gh_request GET "/repos/$REPO")
preflight_status=$(jq -r '.status' <<<"$preflight")
if [[ "$preflight_status" != "200" ]]; then
	printf 'audit: cannot read %s (GET /repos/%s -> %s); check that the token is authenticated for this repository\n' "$REPO" "$REPO" "$preflight_status" >&2
	exit 2
fi
if [[ "$(jq -r '.body.permissions.admin // false' <<<"$preflight")" != "true" ]]; then
	printf 'audit: missing admin permission on %s (GET /repos/%s -> permissions.admin is not true); branch protection and security settings require admin\n' "$REPO" "$REPO" >&2
	exit 2
fi
DEFAULT_BRANCH=$(jq -r '.body.default_branch // "main"' <<<"$preflight")

# --- evidence gathering ----------------------------------------------------

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
	profile=$(gh_request GET "/repos/$REPO/community/profile")
	while IFS= read -r path; do
		resp=$(gh_request GET "/repos/$REPO/contents/$path")
		probes=$(jq -c --arg p "$path" --argjson r "$resp" '. + [{path: $p, status: $r.status, body: $r.body}]' <<<"$probes")
	done < <(community_probe_paths "$id")
	jq -c -n \
		--arg slug "$REPO" --arg branch "$DEFAULT_BRANCH" \
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
		# evidence and the 401/403 branch is reachable (that is the only way
		# GitHub says "not available to this plan").
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

# --- evaluate --------------------------------------------------------------

ROWS='[]'
for id in "${IDS[@]}"; do
	evidence=$(gather_evidence "$id")
	if ! row=$(printf '%s' "$evidence" | jq -c -f "$EVALUATE" --arg id "$id"); then
		printf 'audit: cannot evaluate "%s" from the gathered evidence\n' "$id" >&2
		exit 2
	fi
	ROWS=$(jq -c --argjson row "$row" '. + [$row]' <<<"$ROWS")
done

# --- report ----------------------------------------------------------------

print_table() {
	local rows="$1" row
	printf '%-36s %-14s %s\n' "CHECK" "STATUS" "EVIDENCE"
	while IFS= read -r row; do
		printf '%-36s %-14s %s\n' \
			"$(jq -r '.id' <<<"$row")" \
			"$(jq -r '.status' <<<"$row")" \
			"$(jq -r 'if (.evidence | length) > 0 then (.evidence | join("; ")) else "-" end' <<<"$row")"
	done < <(jq -c '.[]' <<<"$rows")
	printf '\n'
	printf 'summary: %s\n' "$(jq -r 'group_by(.status) | map("\(.[0].status)=\(length)") | join(" ")' <<<"$rows")"
}

if ((JSON_OUT == 1)); then
	printf '%s\n' "$ROWS"
else
	print_table "$ROWS"
fi

if jq -e 'any(.[]; .status == "unknown")' <<<"$ROWS" >/dev/null; then
	printf 'audit: at least one practice could not be evaluated (status "unknown"); resolve the permission or API gap and re-run\n' >&2
	exit 1
fi

exit 0
