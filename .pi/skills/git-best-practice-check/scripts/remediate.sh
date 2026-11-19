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

# Inputs a write cannot proceed without are validated before the first write,
# so a refused remediation leaves the repository untouched.
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

STEP="re-audit"
row=$(reaudit "$ID")
STATUS=$(jq -r '.[0].status // "unknown"' <<<"$row")
REMEDIABLE=$(jq -r '.[0].remediable // false' <<<"$row")

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
