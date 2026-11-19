#!/usr/bin/env bash
# remediate-args.sh — the invocation half of remediate.sh.
#
# Kept apart from remediate.sh so the consent gate and the write dispatch can be
# read on one screen: this file only parses argv and validates the check id, and
# it writes nothing. Sourced by remediate.sh, never by an entry point.
#
# Sets the caller's globals (bash functions assign globally unless declared
# local): ID, CONSENT, REPO_ARG, REPO_SET, SETTINGS, FULLNAME, LICENSE_KEY,
# BRANCH. Exits 64 on a bad invocation and 0 for --help, exactly as the entry
# point documents.

remediate_usage() {
	printf '%s\n' \
		'usage: remediate.sh <check-id> --consent [--repo owner/repo] [--settings <path>]' \
		'                    [--fullname "Name"] [--license-key mit] [--branch name]' \
		'' \
		'Applies exactly one remediation for a failing practice and re-verifies it.' \
		'--consent is mandatory: the SKILL.md flow only passes it after the user' \
		'answered yes to "Remediate <practice>? (y/n)".'
}

# parse_remediate_args <argv...> — parse the command line into the globals above.
parse_remediate_args() {
	while (($# > 0)); do
		case "$1" in
		--consent)
			CONSENT=1
			shift
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
			remediate_usage
			exit 0
			;;
		-*)
			printf 'remediate: unknown option "%s"\n' "$1" >&2
			remediate_usage >&2
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
}

# require_known_id <id> <valid-id>... — exit 64 unless <id> is a checklist id.
#
# The id set comes from evaluate.jq (`--arg mode list-ids`), so a remediation
# can never target a practice the audit does not evaluate.
require_known_id() {
	local id="${1-}"
	shift
	local candidate
	for candidate in "$@"; do
		if [[ "$candidate" == "$id" ]]; then
			return 0
		fi
	done
	printf 'remediate: unknown check id "%s"; valid ids: %s\n' "$id" "$*" >&2
	exit 64
}
