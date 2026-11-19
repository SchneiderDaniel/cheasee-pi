#!/usr/bin/env bash
# audit.sh — read-only audit of one repository against the skill checklist.
#
# usage: audit.sh [--repo owner/repo] [--check <id>] [--settings <path>] [--json]
#
# Evidence gathering lives in lib/evidence.sh, the verdict rules in evaluate.jq,
# the table in lib/report.sh. This file is the use case: resolve, preflight,
# gather, evaluate, report.
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
# shellcheck source=lib/evidence.sh
source "$SCRIPT_DIR/lib/evidence.sh"
# shellcheck source=lib/report.sh
source "$SCRIPT_DIR/lib/report.sh"

EVALUATE="$SCRIPT_DIR/evaluate.jq"

usage() {
	printf '%s\n' \
		'usage: audit.sh [--repo owner/repo] [--check <id>] [--settings <path>] [--json]' \
		'' \
		'Read-only audit against the git-best-practice-check checklist. Default output' \
		'is a table with one row per practice plus the evidence behind each verdict;' \
		'--json prints the same rows as a JSON array.' \
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
# Admin is required for branch protection plus the security settings. Keeping a
# permission gap separate from "practice failed" stops the audit from telling
# the user to fix something it cannot see.
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
