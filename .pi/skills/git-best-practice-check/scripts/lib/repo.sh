#!/usr/bin/env bash
# repo.sh — the only place that decides which repository is audited.
#
# `resolve_repo [override]` prints `owner/repo` on stdout.
#   * an explicit override (--repo) wins;
#   * otherwise `supervisor.repo` is read from $GBPC_SETTINGS_FILE
#     (default .pi/settings.json).
# It never calls gh: a malformed target must fail before any request is made.

resolve_repo() {
	local settings="${GBPC_SETTINGS_FILE:-.pi/settings.json}"
	local repo owner name

	if (($# > 0)); then
		repo="${1}"
		if [[ -z "$repo" ]]; then
			printf 'repo: empty --repo value; expected "owner/repo"\n' >&2
			return 2
		fi
	else
		if [[ ! -f "$settings" ]]; then
			printf 'repo: settings file "%s" not found; set "supervisor": {"repo": "owner/repo"} or pass --repo owner/repo\n' "$settings" >&2
			return 2
		fi
		if ! repo=$(jq -r '.supervisor.repo // empty' "$settings" 2>/dev/null); then
			printf 'repo: "%s" is not valid JSON\n' "$settings" >&2
			return 2
		fi
		if [[ -z "$repo" ]]; then
			printf 'repo: "supervisor.repo" is missing or blank in "%s"; set it to "owner/repo" or pass --repo owner/repo\n' "$settings" >&2
			return 2
		fi
	fi

	# Tolerate whitespace and a leading/trailing slash, nothing else.
	repo="${repo#"${repo%%[![:space:]]*}"}"
	repo="${repo%"${repo##*[![:space:]]}"}"
	repo="${repo#/}"
	repo="${repo%/}"

	owner="${repo%%/*}"
	name="${repo#*/}"
	if [[ "$repo" != */* || -z "$owner" || -z "$name" || "$name" == */* ]]; then
		printf 'repo: expected "owner/repo" shape, got "%s"\n' "$repo" >&2
		return 2
	fi

	printf '%s' "$repo"
}

# resolve_repo_arg <0|1> <value> — resolve_repo for a parsed command line.
#
# The caller reports whether `--repo` was supplied at all, so an explicitly
# empty value is rejected by resolve_repo instead of silently falling back to
# `supervisor.repo` (which would audit, or worse write to, the wrong repo).
resolve_repo_arg() {
	if [[ "${1:-0}" == "1" ]]; then
		resolve_repo "${2:-}"
	else
		resolve_repo
	fi
}
