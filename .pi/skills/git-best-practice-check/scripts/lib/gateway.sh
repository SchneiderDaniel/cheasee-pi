#!/usr/bin/env bash
# gateway.sh — the single `gh` call site for git-best-practice-check.
#
# Contract: `gh_request <METHOD> <path> [json-body]`
#   stdout: {"status": <int>, "body": <json|null>}
#   exit 0 for every HTTP response, including 4xx/5xx
#   exit 1 only when there is no HTTP response at all (auth, DNS, TLS, garbage)
#
# Two deliberate choices protect the audit:
#   * --method is always explicit and --include always present, so the HTTP
#     status is visible. Adding any -f/-F flag silently flips gh to POST and
#     stringifies booleans, so bodies are delivered verbatim through --input.
#   * a non-2xx response is returned to the caller, never folded into a pass.
#     Only a missing status line (no HTTP response) is treated as a failure.

gh_request() {
	local method="${1:-}"
	local path="${2:-}"
	local body="${3:-}"

	case "$method" in
	GET | POST | PUT | PATCH | DELETE) ;;
	*)
		printf 'gateway: unsupported method "%s"\n' "$method" >&2
		return 64
		;;
	esac

	if [[ -z "$path" ]]; then
		printf 'gateway: missing request path\n' >&2
		return 64
	fi

	local scratch out err gh_rc=0
	scratch=$(mktemp -d) || {
		printf 'gateway: cannot create a scratch directory\n' >&2
		return 1
	}
	out="$scratch/stdout"
	err="$scratch/stderr"

	# `gh` exits non-zero for HTTP 4xx/5xx too, so the exit code alone cannot
	# distinguish "GitHub answered" from "no answer". The status line decides.
	if [[ -n "$body" ]]; then
		printf '%s' "$body" | gh api --include --method "$method" "$path" --input - >"$out" 2>"$err" || gh_rc=$?
	else
		gh api --include --method "$method" "$path" >"$out" 2>"$err" || gh_rc=$?
	fi

	local status
	status=$(awk 'NR == 1 && $1 ~ /^HTTP\// { print $2; exit }' "$out")

	if [[ -z "$status" ]]; then
		printf 'gateway: no HTTP response for %s %s (gh exit %s)\n' "$method" "$path" "$gh_rc" >&2
		cat "$err" >&2
		rm -rf "$scratch"
		return 1
	fi

	local payload json
	payload=$(awk 'seen { print } /^\r?$/ { seen = 1 }' "$out")

	if [[ -z "${payload//[[:space:]]/}" ]]; then
		json="null"
	elif ! json=$(printf '%s' "$payload" | jq -c . 2>/dev/null); then
		printf 'gateway: response body for %s %s is not JSON\n' "$method" "$path" >&2
		cat "$out" >&2
		rm -rf "$scratch"
		return 1
	fi

	rm -rf "$scratch"
	jq -c -n --argjson status "$status" --argjson body "$json" '{status: $status, body: $body}'
}
