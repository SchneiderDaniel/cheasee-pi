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

# Fork-free script dir: two processes saved per run, on a path that cannot
# change during the run.
case "${BASH_SOURCE[0]}" in
*/*) SCRIPT_DIR="${BASH_SOURCE[0]%/*}" ;;
*) SCRIPT_DIR="." ;;
esac
# shellcheck source=lib/gateway.sh
source "$SCRIPT_DIR/lib/gateway.sh"

trap gateway_cleanup EXIT
# shellcheck source=lib/repo.sh
source "$SCRIPT_DIR/lib/repo.sh"
# shellcheck source=lib/remediate-common.sh
source "$SCRIPT_DIR/lib/remediate-common.sh"
# shellcheck source=lib/remediate-branch.sh
source "$SCRIPT_DIR/lib/remediate-branch.sh"
# shellcheck source=lib/remediate-security.sh
source "$SCRIPT_DIR/lib/remediate-security.sh"
# shellcheck source=lib/remediate-community.sh
source "$SCRIPT_DIR/lib/remediate-community.sh"
# shellcheck source=lib/remediate-verify.sh
source "$SCRIPT_DIR/lib/remediate-verify.sh"
# shellcheck source=lib/remediate-args.sh
source "$SCRIPT_DIR/lib/remediate-args.sh"

EVALUATE="$SCRIPT_DIR/evaluate.jq"
AUDIT="$SCRIPT_DIR/audit.sh"
CONSENT=0
ID=""
REPO_ARG=""
REPO_SET=0
SETTINGS=""
FULLNAME=""
LICENSE_KEY="mit"
BRANCH=""
SKIP_VERIFY=0
STEP="audit"
repo_status=""

# argv parsing lives in remediate-args.sh (remediate_usage + parse_remediate_args).
parse_remediate_args "$@"

mapfile -t ALL_IDS < <(jq -n -r -f "$EVALUATE" --arg mode list-ids)

if ((CONSENT == 0)); then
	printf 'remediate: consent missing; refusing to change "%s" without an explicit yes from the user (pass --consent)\n' "${ID:-<none>}" >&2
	exit 3
fi

if [[ -z "$ID" ]]; then
	printf 'remediate: missing check id; valid ids: %s\n' "${ALL_IDS[*]}" >&2
	exit 64
fi

require_known_id "$ID" "${ALL_IDS[@]}"

if [[ -n "$SETTINGS" ]]; then
	export GBPC_SETTINGS_FILE="$SETTINGS"
fi

# An explicit --repo goes through even when empty, so `resolve_repo_arg` can
# reject it instead of falling back to supervisor.repo: a consented write must
# never land on a repository the user did not name.
if ! REPO=$(resolve_repo_arg "$REPO_SET" "$REPO_ARG"); then
	exit 2
fi

# Inputs a write cannot proceed without are validated before the first write,
# so a refused remediation leaves the repository untouched.
if [[ "$ID" == "community-license" && -z "$FULLNAME" ]]; then
	printf 'remediate: missing input --fullname (the copyright holder substituted for [fullname] in the license template)\n' >&2
	exit 64
fi

repo_payload=$(gh_request GET "/repos/$REPO")
if ! repo_status=$(response_status "$repo_payload"); then
	printf 'remediate: unexpected gateway response for GET /repos/%s\n' "$REPO" >&2
	exit 2
fi
if [[ "$repo_status" != "200" ]]; then
	printf 'remediate: cannot read %s (GET /repos/%s -> %s)\n' "$REPO" "$REPO" "$repo_status" >&2
	exit 2
fi
if ! DEFAULT_BRANCH=$(jq -r '.body.default_branch // "main"' <<<"$repo_payload"); then
	printf 'remediate: cannot read the default branch of %s\n' "$REPO" >&2
	exit 2
fi

# --- re-audit before any write ---------------------------------------------

STEP="re-audit"
row=$(reaudit "$ID")
if ! IFS=$'\t' read -r STATUS REMEDIABLE < <(jq -r '.[0] | [.status // "unknown", (.remediable // false | tostring)] | @tsv' <<<"$row"); then
	printf 'remediate: cannot read the re-audit row for %s\n' "$ID" >&2
	exit 2
fi

if [[ "$STATUS" != "fail" || "$REMEDIABLE" != "true" ]]; then
	printf 'remediate: refusing to change %s (step: %s, status: %s, remediable: %s); only failing practices are remediated\n' \
		"$ID" "$STEP" "$STATUS" "$REMEDIABLE" >&2
	exit 4
fi

# --- apply one write -------------------------------------------------------

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
