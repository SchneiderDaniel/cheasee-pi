#!/usr/bin/env bash
# remediate-community.sh — create the missing community standards files.
#
# Files never land on the default branch: one feature branch is cut from the
# default-branch head, every file is written to it through the contents API,
# then one pull request is opened. A bare contents write would land on the
# default branch, which the skill forbids.

COMMUNITY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# file_content <path> — the body for one scaffold file.
file_content() {
	local path="$1" name="${REPO#*/}" body
	if [[ "$path" == "LICENSE" ]]; then
		license_body
		return $?
	fi
	body=$(jq -r -n -f "$COMMUNITY_LIB_DIR/community-files.jq" --arg path "$path" --arg name "$name")
	if [[ -z "$body" ]]; then
		printf 'remediate: no content generator for "%s"\n' "$path" >&2
		return 64
	fi
	printf '%s' "$body"
}

# create_ref <branch> <sha> — POST git/refs.
create_ref() {
	local branch="$1" sha="$2" response
	STEP="create-feature-branch"
	response=$(gh_request POST "/repos/$REPO/git/refs" "$(jq -c -n --arg ref "refs/heads/$branch" --arg sha "$sha" '{ref: $ref, sha: $sha}')")
	require_success "create the branch $branch" "$response"
}

# write_file <branch> <path> <content> — PUT contents/{path} onto <branch> only.
write_file() {
	local branch="$1" path="$2" content="$3" encoded response
	encoded=$(printf '%s' "$content" | base64 | tr -d '\n')
	response=$(gh_request PUT "/repos/$REPO/contents/$path" \
		"$(jq -c -n --arg message "chore: add $path" --arg content "$encoded" --arg branch "$branch" \
			'{message: $message, content: $content, branch: $branch}')")
	require_success "create $path on $branch" "$response"
}

# open_pull_request <branch> — POST pulls into the default branch.
open_pull_request() {
	local branch="$1" response
	STEP="open-pull-request"
	response=$(gh_request POST "/repos/$REPO/pulls" \
		"$(jq -c -n \
			--arg title "chore: add missing community standards files" \
			--arg head "$branch" \
			--arg base "$DEFAULT_BRANCH" \
			--arg body "Adds the community standards files that git-best-practice-check reported as missing. Opened on a feature branch on purpose: the practice passes once this is merged, never by committing to $DEFAULT_BRANCH directly." \
			'{title: $title, head: $head, base: $base, body: $body, draft: false}')")
	require_success "open a pull request from $branch into $DEFAULT_BRANCH" "$response"
}

remediate_community() {
	local id="$1" branch head_response head_sha path content
	local -a files=() contents=()
	mapfile -t files < <(community_default_files "$id")
	if ((${#files[@]} == 0)); then
		printf 'remediate: no community files to create for "%s"\n' "$id" >&2
		return 64
	fi

	# Render every file before the first write: a failing template fetch must
	# leave no dangling branch behind.
	for path in "${files[@]}"; do
		if ! content=$(file_content "$path"); then
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

	create_ref "$branch" "$head_sha" || return 1
	STEP="write-community-files"
	for index in "${!files[@]}"; do
		write_file "$branch" "${files[$index]}" "${contents[$index]}" || return 1
	done
	open_pull_request "$branch" || return 1
	printf 'community files are on %s; review and merge the pull request\n' "$branch"
}
