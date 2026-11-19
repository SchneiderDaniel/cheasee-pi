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

trap gateway_cleanup EXIT
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
REPO_SET=0
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
		REPO_SET=1
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

# Wall clock for the recency rule in evaluate.jq. It is an input to the pure
# rules, not something they read; GBPC_NOW pins it for tests.
NOW_EPOCH="${GBPC_NOW:-$(date -u +%s)}"

# An explicit --repo is passed through even when empty, so `resolve_repo_arg`
# can reject it instead of silently falling back to supervisor.repo (auditing —
# and later remediating — a repository the user did not ask for).
if ! REPO=$(resolve_repo_arg "$REPO_SET" "$REPO_ARG"); then
	exit 2
fi

# --- preflight -------------------------------------------------------------
# Admin is required for branch protection plus the security settings. Keeping a
# permission gap separate from "practice failed" stops the audit from telling
# the user to fix something it cannot see.
preflight=$(gh_request GET "/repos/$REPO")
# One jq for the three facts the rest of the run needs: the status line decides
# whether the repo is readable at all, `permissions.admin` whether the token may
# audit security settings, and `default_branch` keeps the branch checks honest.
IFS=$'\t' read -r preflight_status preflight_admin DEFAULT_BRANCH < <(
	jq -r '[.status, (.body.permissions.admin // false | tostring), (.body.default_branch // "main")] | @tsv' <<<"$preflight"
) || true
if [[ "$preflight_status" != "200" ]]; then
	printf 'audit: cannot read %s (GET /repos/%s -> %s); check that the token is authenticated for this repository\n' "$REPO" "$REPO" "$preflight_status" >&2
	exit 2
fi
if [[ "$preflight_admin" != "true" ]]; then
	printf 'audit: missing admin permission on %s (GET /repos/%s -> permissions.admin is not true); branch protection and security settings require admin\n' "$REPO" "$REPO" >&2
	exit 2
fi

# --- evidence --------------------------------------------------------------

# The community profile is one document describing every community check, so
# it is read once for the run instead of once per check (see lib/evidence.sh).
ensure_community_profile "${IDS[@]}"

# --- evaluate --------------------------------------------------------------

# Rows are appended as the compact JSON objects jq prints, so the array is
# assembled by the shell: eleven checks would otherwise cost eleven more jq
# processes for string concatenation.
rows=()
for id in "${IDS[@]}"; do
	evidence=$(gather_evidence "$id")
	if ! row=$(printf '%s' "$evidence" | jq -c -f "$EVALUATE" --arg id "$id" --argjson now "$NOW_EPOCH"); then
		printf 'audit: cannot evaluate "%s" from the gathered evidence\n' "$id" >&2
		exit 2
	fi
	rows+=("$row")
done
ROWS=$(printf '[%s]' "$(IFS=,; printf '%s' "${rows[*]}")")

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
