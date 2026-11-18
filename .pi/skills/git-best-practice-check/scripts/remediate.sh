#!/usr/bin/env bash
# remediate.sh — one consented write per practice, then re-verify.
#
# usage: remediate.sh <check-id> --consent [--repo owner/repo] [--settings <path>]
#                    [--fullname "Name"] [--license-key mit] [--branch name]
#
# The skill asks the user "Remediate <practice>? (y/n)" and only calls this
# script with --consent after an explicit yes. Fail-closed rules:
#   * no --consent            → refuse, zero writes
#   * status is not `fail`    → refuse, zero writes (pass/pending/not-available/unknown)
#   * status changed on the re-audit that precedes every write → refuse
#   * a rejected write or a re-verify that still fails → non-zero exit
#
# exit 0  — applied and reported (including "pending" for async work)
# exit 1  — a write or the re-verification failed
# exit 2  — repo could not be resolved / read
# exit 3  — consent missing
# exit 4  — practice is not remediable in its current state
# exit 64 — bad invocation
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/gateway.sh
source "$SCRIPT_DIR/lib/gateway.sh"
# shellcheck source=lib/repo.sh
source "$SCRIPT_DIR/lib/repo.sh"

EVALUATE="$SCRIPT_DIR/evaluate.jq"
AUDIT="$SCRIPT_DIR/audit.sh"

usage() {
	printf '%s\n' \
		'usage: remediate.sh <check-id> --consent [--repo owner/repo] [--settings <path>]' \
		'                    [--fullname "Name"] [--license-key mit] [--branch name]' \
		'' \
		'Applies exactly one remediation for a failing practice and re-verifies it.' \
		'--consent is mandatory: the SKILL.md flow only passes it after the user' \
		'answered yes to "Remediate <practice>? (y/n)".'
}

CONSENT=0
ID=""
REPO_ARG=""
SETTINGS=""
FULLNAME=""
LICENSE_KEY="mit"
BRANCH=""
SKIP_VERIFY=0
STEP="audit"

while (($# > 0)); do
	case "$1" in
	--consent)
		CONSENT=1
		shift
		;;
	--repo)
		REPO_ARG="${2:-}"
		shift 2
		;;
	--settings)
		SETTINGS="${2:-}"
		shift 2
		;;
	--fullname)
		FULLNAME="${2:-}"
		shift 2
		;;
	--license-key)
		LICENSE_KEY="${2:-}"
		shift 2
		;;
	--branch)
		BRANCH="${2:-}"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	-*)
		printf 'remediate: unknown option "%s"\n' "$1" >&2
		usage >&2
		exit 64
		;;
	*)
		if [[ -n "$ID" ]]; then
			printf 'remediate: only one check id may be remediated per invocation (got "%s" and "%s")\n' "$ID" "$1" >&2
			exit 64
		fi
		ID="$1"
		shift
		;;
	esac
done

mapfile -t ALL_IDS < <(jq -n -r -f "$EVALUATE" --arg mode list-ids)

if ((CONSENT == 0)); then
	printf 'remediate: consent missing; refusing to change "%s" without an explicit yes from the user (pass --consent)\n' "${ID:-<none>}" >&2
	exit 3
fi

if [[ -z "$ID" ]]; then
	printf 'remediate: missing check id; valid ids: %s\n' "${ALL_IDS[*]}" >&2
	exit 64
fi

known=0
for candidate in "${ALL_IDS[@]}"; do
	if [[ "$candidate" == "$ID" ]]; then known=1; fi
done
if ((known == 0)); then
	printf 'remediate: unknown check id "%s"; valid ids: %s\n' "$ID" "${ALL_IDS[*]}" >&2
	exit 64
fi

if [[ -n "$SETTINGS" ]]; then
	export GBPC_SETTINGS_FILE="$SETTINGS"
fi

if ! REPO=$(resolve_repo ${REPO_ARG:+"$REPO_ARG"}); then
	exit 2
fi

# Inputs that a write cannot proceed without are validated before the first
# write, so a refused remediation leaves the repository untouched.
if [[ "$ID" == "community-license" && -z "$FULLNAME" ]]; then
	printf 'remediate: missing input --fullname (the copyright holder substituted for [fullname] in the license template)\n' >&2
	exit 64
fi

repo_payload=$(gh_request GET "/repos/$REPO")
if [[ "$(jq -r '.status' <<<"$repo_payload")" != "200" ]]; then
	printf 'remediate: cannot read %s (GET /repos/%s -> %s)\n' "$REPO" "$REPO" "$(jq -r '.status' <<<"$repo_payload")" >&2
	exit 2
fi
DEFAULT_BRANCH=$(jq -r '.body.default_branch // "main"' <<<"$repo_payload")

# --- re-audit before any write ---------------------------------------------

reaudit() {
	local id="$1" out rc=0
	local -a args=(--json --check "$id" --repo "$REPO")
	if [[ -n "$SETTINGS" ]]; then
		args+=(--settings "$SETTINGS")
	fi
	out=$(bash "$AUDIT" "${args[@]}") || rc=$?
	if [[ -z "$out" ]]; then
		printf 'remediate: audit produced no output for %s (exit %s)\n' "$id" "$rc" >&2
		return 1
	fi
	printf '%s' "$out"
}

STEP="re-audit"
row=$(reaudit "$ID")
STATUS=$(jq -r '.[0].status // "unknown"' <<<"$row")
REMEDIABLE=$(jq -r '.[0].remediable // false' <<<"$row")

if [[ "$STATUS" != "fail" || "$REMEDIABLE" != "true" ]]; then
	printf 'remediate: refusing to change %s (step: %s, status: %s, remediable: %s); only failing practices are remediated\n' \
		"$ID" "$STEP" "$STATUS" "$REMEDIABLE" >&2
	exit 4
fi

# --- helpers ---------------------------------------------------------------

require_success() { # <description> <gateway-response>
	local description="$1" response="$2" status
	status=$(jq -r '.status' <<<"$response")
	if [[ "$status" =~ ^2[0-9][0-9]$ ]]; then
		return 0
	fi
	printf 'remediate: %s failed (HTTP %s): %s\n' "$description" "$status" "$(jq -c '.body' <<<"$response")" >&2
	return 1
}

# --- branch protection -----------------------------------------------------

remediate_branch_protection() {
	local current current_body payload response
	current=$(gh_request GET "/repos/$REPO/branches/$DEFAULT_BRANCH/protection")
	if [[ "$(jq -r '.status' <<<"$current")" == "200" ]]; then
		current_body=$(jq -c '.body' <<<"$current")
	else
		current_body='{}'
	fi

	# The update endpoint REPLACES the whole configuration and requires all four
	# top-level fields, so this is a read-modify-write: the checklist settings
	# are merged into whatever exists, and no status check is invented.
	payload=$(jq -c -n --argjson current "$current_body" '
		def logins($items):
			[($items // [])[] | if type == "object" then (.login // .slug // empty) else . end];
		($current.required_status_checks // null) as $checks
		| ($current.required_pull_request_reviews // {}) as $reviews
		| {
			required_status_checks: (
				if $checks == null then null
				else {
					strict: ($checks.strict // false),
					contexts: ($checks.contexts // []),
					checks: ($checks.checks // [])
				} end),
			enforce_admins: true,
			required_pull_request_reviews: (
				{
					dismiss_stale_reviews: ($reviews.dismiss_stale_reviews // false),
					require_code_owner_reviews: ($reviews.require_code_owner_reviews // false),
					required_approving_review_count: 1,
					require_last_push_approval: ($reviews.require_last_push_approval // false)
				}
				+ (if ($reviews.dismissal_restrictions // null) == null then {} else {
					dismissal_restrictions: {
						users: logins($reviews.dismissal_restrictions.users),
						teams: logins($reviews.dismissal_restrictions.teams)
					} } end)
				+ (if ($reviews.bypass_pull_request_allowances // null) == null then {} else {
					bypass_pull_request_allowances: {
						users: logins($reviews.bypass_pull_request_allowances.users),
						teams: logins($reviews.bypass_pull_request_allowances.teams),
						apps: logins($reviews.bypass_pull_request_allowances.apps)
					} } end)
			),
			restrictions: (
				if ($current.restrictions // null) == null then null
				else {
					users: logins($current.restrictions.users),
					teams: logins($current.restrictions.teams),
					apps: logins($current.restrictions.apps)
				} end)
		}')

	STEP="write-branch-protection"
	response=$(gh_request PUT "/repos/$REPO/branches/$DEFAULT_BRANCH/protection" "$payload")
	require_success "protect $DEFAULT_BRANCH (1+ approving review, admins enforced)" "$response"
}

# --- security features -----------------------------------------------------

remediate_dependabot_alerts() {
	local response
	STEP="write-dependabot-alerts"
	response=$(gh_request PUT "/repos/$REPO/vulnerability-alerts")
	require_success "enable dependabot alerts" "$response"
}

remediate_secret_scanning() {
	local response
	STEP="write-secret-scanning"
	response=$(gh_request PATCH "/repos/$REPO" '{"security_and_analysis":{"secret_scanning":{"status":"enabled"}}}')
	require_success "enable secret scanning" "$response"
}

remediate_code_scanning() {
	local response attempt attempts interval state
	STEP="write-code-scanning"
	response=$(gh_request PATCH "/repos/$REPO/code-scanning/default-setup" '{"state":"configured","query_suite":"default"}')
	require_success "enable code scanning default setup" "$response"

	# Onboarding is asynchronous: the PATCH can return 202/200 while default
	# setup still reads not-configured. Poll a bounded number of times, then
	# report pending rather than inventing a pass or a fail.
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

# --- community standards ---------------------------------------------------

community_default_files() {
	case "$1" in
	community-readme) printf '%s\n' "README.md" ;;
	community-code-of-conduct) printf '%s\n' "CODE_OF_CONDUCT.md" ;;
	community-contributing) printf '%s\n' "CONTRIBUTING.md" ;;
	community-license) printf '%s\n' "LICENSE" ;;
	community-security-policy) printf '%s\n' "SECURITY.md" ;;
	community-issue-templates) printf '%s\n' ".github/ISSUE_TEMPLATE/bug_report.md" ".github/ISSUE_TEMPLATE/feature_request.md" ;;
	community-pull-request-template) printf '%s\n' ".github/PULL_REQUEST_TEMPLATE.md" ;;
	*)
		printf 'remediate: no community file defined for "%s"\n' "$1" >&2
		return 64
		;;
	esac
}

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

file_content() { # <check-id> <path>
	local id="$1" path="$2" name="${REPO#*/}"
	if [[ "$path" == "LICENSE" ]]; then
		license_body
		return $?
	fi
	case "$id" in
	community-readme)
		printf '# %s\n\n<!-- One paragraph: what this project does, who it is for, and how to get started. -->\n\n## Getting started\n\nSee CONTRIBUTING.md for the development setup.\n\n## License\n\nSee LICENSE.\n' "$name"
		;;
	community-code-of-conduct)
		printf '# Contributor Covenant Code of Conduct\n\n## Our pledge\n\nWe as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone.\n\n## Our standards\n\nExamples of behaviour that contributes to a positive environment include empathy, respect for differing opinions, and graceful acceptance of constructive feedback. Examples of unacceptable behaviour include harassment, derogatory comments, and publishing private information.\n\n## Enforcement\n\nReport unacceptable behaviour to the repository maintainers. All complaints will be reviewed and investigated promptly and fairly.\n\n## Attribution\n\nThis Code of Conduct is adapted from the Contributor Covenant, version 2.1.\n'
		;;
	community-contributing)
		printf '# Contributing to %s\n\n## Before you start\n\nOpen an issue that describes the change you intend to make. Small, focused pull requests review faster than large ones.\n\n## Development loop\n\n1. Branch from the default branch.\n2. Make the change and add tests.\n3. Run the project test command and the type-check.\n4. Open a pull request that states the problem and the verification you ran.\n\n## Commit messages\n\nUse an imperative subject line and explain the why in the body.\n' "$name"
		;;
	community-security-policy)
		printf '# Security policy\n\n## Supported versions\n\nThe latest release on the default branch receives security fixes.\n\n## Reporting a vulnerability\n\nDo not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting ("Security" tab -> "Report a vulnerability") or contact the maintainers directly. Expect an acknowledgement within 7 days.\n\n## Scope\n\nSecrets, authentication, dependency supply chain, and anything that can leak user data.\n'
		;;
	community-issue-templates)
		case "$path" in
		*feature_request.md)
			printf '%s\n' '---' 'name: Feature request' 'about: Suggest an idea for this project' "title: ''" 'labels: enhancement' '---' '' '## Problem' '' 'What problem are you trying to solve?' '' '## Proposed solution' '' 'What should happen instead?' '' '## Alternatives considered' '' 'What else did you try or consider?'
			;;
		*)
			printf '%s\n' '---' 'name: Bug report' 'about: Report a defect in this project' "title: ''" 'labels: bug' '---' '' '## What happened' '' 'A clear description of the defect.' '' '## Steps to reproduce' '' '1.' '2.' '' '## Expected behaviour' '' 'What did you expect instead?' '' '## Environment' '' 'Version, platform, and anything else that helps.'
			;;
		esac
		;;
	community-pull-request-template)
		printf '%s\n' '## Problem' '' 'What problem does this change solve? Link the issue.' '' '## Change' '' 'What did you change, and why this way?' '' '## Verification' '' '- [ ] Tests added or updated' '- [ ] Test command passes locally' '- [ ] Documentation updated (if behaviour changed)'
		;;
	*)
		printf 'remediate: no content generator for "%s"\n' "$id" >&2
		return 64
		;;
	esac
}

remediate_community() {
	local id="$1" branch head_response head_sha response payload path content encoded
	local -a files=() contents=()
	mapfile -t files < <(community_default_files "$id")
	if ((${#files[@]} == 0)); then
		printf 'remediate: no community files to create for "%s"\n' "$id" >&2
		return 64
	fi

	# Render every file before the first write: a failing template fetch must
	# leave no dangling branch behind.
	for path in "${files[@]}"; do
		if ! content=$(file_content "$id" "$path"); then
			return 1
		fi
		contents+=("$content")
	done

	branch="${BRANCH:-git-best-practice-check/${id}-$(date -u +%Y%m%d%H%M%S)}"

	STEP="resolve-default-branch-head"
	head_response=$(gh_request GET "/repos/$REPO/git/ref/heads/$DEFAULT_BRANCH")
	head_sha=$(jq -r '.body.object.sha // ""' <<<"$head_response")
	if [[ -z "$head_sha" ]]; then
		printf 'remediate: cannot resolve the head of %s (HTTP %s)\n' "$DEFAULT_BRANCH" "$(jq -r '.status' <<<"$head_response")" >&2
		return 1
	fi

	STEP="create-feature-branch"
	response=$(gh_request POST "/repos/$REPO/git/refs" "$(jq -c -n --arg ref "refs/heads/$branch" --arg sha "$head_sha" '{ref: $ref, sha: $sha}')")
	require_success "create the branch $branch" "$response" || return 1

	STEP="write-community-files"
	for index in "${!files[@]}"; do
		path="${files[$index]}"
		encoded=$(printf '%s' "${contents[$index]}" | base64 | tr -d '\n')
		payload=$(jq -c -n --arg message "chore: add $path" --arg content "$encoded" --arg branch "$branch" \
			'{message: $message, content: $content, branch: $branch}')
		response=$(gh_request PUT "/repos/$REPO/contents/$path" "$payload")
		require_success "create $path on $branch" "$response" || return 1
	done

	STEP="open-pull-request"
	payload=$(jq -c -n \
		--arg title "chore: add missing community standards files" \
		--arg head "$branch" \
		--arg base "$DEFAULT_BRANCH" \
		--arg body "Adds the community standards files that git-best-practice-check reported as missing. Opened on a feature branch on purpose: the practice passes once this is merged, never by committing to $DEFAULT_BRANCH directly." \
		'{title: $title, head: $head, base: $base, body: $body, draft: false}')
	response=$(gh_request POST "/repos/$REPO/pulls" "$payload")
	require_success "open a pull request from $branch into $DEFAULT_BRANCH" "$response" || return 1
	printf 'community files are on %s; review and merge the pull request\n' "$branch"
}

# --- re-verify -------------------------------------------------------------

verify() {
	local id="$1" refreshed status
	STEP="re-verify"
	if ! refreshed=$(reaudit "$id"); then
		return 1
	fi
	status=$(jq -r '.[0].status // "unknown"' <<<"$refreshed")
	if [[ "$status" == "pass" ]]; then
		printf '%s: fail → pass\n' "$id"
		return 0
	fi
	if [[ "$status" == "pending" ]]; then
		printf '%s: fail → pending (accepted by GitHub, not effective yet; re-run the audit to confirm)\n' "$id"
		return 0
	fi
	case "$id" in
	community-*)
		# Community files land through a pull request, so the practice only
		# turns green after a human merges it. Reporting pending is the honest
		# state; reporting success here would be a lie.
		printf '%s: fail → pending (pull request opened; merge it to make the practice pass)\n' "$id"
		return 0
		;;
	esac
	printf 'remediate: re-verify failed for %s (step: %s, status: %s)\n' "$id" "$STEP" "$status" >&2
	return 1
}

# --- apply -----------------------------------------------------------------

case "$ID" in
branch-protection) remediate_branch_protection ;;
dependabot-alerts) remediate_dependabot_alerts ;;
secret-scanning) remediate_secret_scanning ;;
code-scanning) remediate_code_scanning ;;
community-*) remediate_community "$ID" ;;
*)
	printf 'remediate: no remediation implemented for "%s"\n' "$ID" >&2
	exit 64
	;;
esac

if ((SKIP_VERIFY == 0)); then
	verify "$ID"
fi
