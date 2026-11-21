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
#
# Everything that is not a JSON transform (status line, body split, path
# encoding) is done in the shell: one `jq` per request keeps an audit of eleven
# checks fast enough to be run interactively.
#
# The request half lives here; the response half (status line, payload split,
# JSON-shape check) lives in gateway-response.sh, sourced below. Both halves stay
# small enough to be read in one sitting, and neither duplicates the other's
# `gh` call site — there is exactly one in the skill.

# shellcheck source=lib/gateway-response.sh
# The sibling is resolved without a $(cd $(dirname ...) && pwd) pair: this file is
# sourced once per script run, and the two processes would buy a path that
# cannot change while the run lasts.
case "${BASH_SOURCE[0]}" in
*/*) GBPC_GATEWAY_DIR="${BASH_SOURCE[0]%/*}" ;;
*) GBPC_GATEWAY_DIR="." ;;
esac
source "$GBPC_GATEWAY_DIR/gateway-response.sh"

# json_quote <destvar> <value> — store <value> as a JSON string literal.
#
# printf -v writes into the caller's variable, so building an evidence bundle
# costs no subshell. Used where a name is interpolated into JSON text instead
# of being passed through `jq --arg`.
json_quote() {
	local __value="${2-}"
	__value="${__value//\\/\\\\}"
	__value="${__value//\"/\\\"}"
	__value="${__value//$'\n'/\\n}"
	__value="${__value//$'\r'/\\r}"
	__value="${__value//$'\t'/\\t}"
	printf -v "$1" '"%s"' "$__value"
}

# urlencode_path_component <value> — percent-encode one URL path segment.
#
# A default branch may legally contain "/" (e.g. "release/2026") or other
# characters that are reserved inside a path. Interpolating it raw changes the
# shape of the request path, so GitHub answers 404 for a branch that does exist
# — a false audit failure and a failing remediation. Every branch name that
# goes into a URL goes through here. LC_ALL=C keeps the loop byte-wise, which is
# what percent-encoding means. The kept set is RFC 3986 "unreserved" — stricter
# than jq's @uri, which also leaves some sub-delimiters (e.g. "'") alone; a
# superset of escaping is safe for every path segment GitHub accepts.
urlencode_path_component() {
	local LC_ALL=C
	local input="${1-}" out="" char=""
	local i
	for ((i = 0; i < ${#input}; i++)); do
		char="${input:i:1}"
		case "$char" in
		[A-Za-z0-9._~-]) out+="$char" ;;
		*)
			printf -v char '%%%02X' "'$char"
			out+="$char"
			;;
		esac
	done
	printf '%s' "$out"
}

# gateway_cleanup — remove this process's scratch file.
#
# The scratch is created once per process instead of once per request: two
# forks per request is a measurable share of an audit that issues twenty of
# them. Entry points install this on EXIT.
gateway_cleanup() {
	if [[ -n "${GBPC_GATEWAY_ERR:-}" ]]; then
		rm -f "$GBPC_GATEWAY_ERR"
	fi
}

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

	GBPC_GATEWAY_ERR="${TMPDIR:-/tmp}/git-best-practice-check.$$.stderr"

	local response_text gh_rc=0

	# `gh` exits non-zero for HTTP 4xx/5xx too, so the exit code alone cannot
	# distinguish "GitHub answered" from "no answer". The status line decides.
	if [[ -n "$body" ]]; then
		response_text=$(printf '%s' "$body" | gh api --include --method "$method" "$path" --input - 2>"$GBPC_GATEWAY_ERR") || gh_rc=$?
	else
		response_text=$(gh api --include --method "$method" "$path" 2>"$GBPC_GATEWAY_ERR") || gh_rc=$?
	fi

	parse_http_response "$method" "$path" "$response_text" "$gh_rc"
}
