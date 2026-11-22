#!/usr/bin/env bash
# gateway-response.sh — the response half of the gh gateway.
#
# Split from gateway.sh so each module stays small: gateway.sh owns the request
# (method flags, --input bodies, the single `gh` call site) while this file owns
# everything that turns the transport's `--include` output into a gateway
# response. It is
# sourced by gateway.sh, never by an entry point, so there is still exactly one
# `gh` call site in the skill.
#
# A gateway response is exactly {"status":<int>,"body":<json|null>} and is
# printed by `parse_http_response`, the only constructor of that shape.

# response_status <gateway-response> — the HTTP status of a gateway response.
#
# The gateway emits exactly {"status":<int>,"body":...}, so the status is a
# prefix and does not need a jq process. Prints the status and returns 0, or
# prints nothing and returns 1 when the argument is not a gateway response.
response_status() {
	if [[ "${1-}" =~ ^\{\"status\":([0-9]+), ]]; then
		printf '%s' "${BASH_REMATCH[1]}"
		return 0
	fi
	return 1
}

# response_body <gateway-response> — the body of a gateway response, verbatim.
#
# Used to re-embed a response body in an evidence bundle without re-parsing it:
# the last character is always the wrapper's "}".
response_body() {
	local response="${1-}" body
	if [[ "$response" != *'"body":'* ]]; then
		return 1
	fi
	body="${response#*\"body\":}"
	printf '%s' "${body%?}"
}

# split_status_line <response-text> — print the HTTP status, or nothing.
#
# A status line looks like "HTTP/2.0 200 OK"; anything without one is not an
# HTTP response at all.
split_status_line() {
	if [[ "${1-}" =~ ^HTTP/[0-9.]+[[:space:]]+([0-9][0-9][0-9]) ]]; then
		printf '%s' "${BASH_REMATCH[1]}"
	fi
}

# response_payload <response-text> — print the body that follows the headers.
#
# The transport separates headers from the payload with a blank line, and an
# empty payload prints nothing.
response_payload() {
	local response_text="${1-}"
	if [[ "$response_text" == *$'\r\n\r\n'* ]]; then
		printf '%s' "${response_text#*$'\r\n\r\n'}"
	elif [[ "$response_text" == *$'\n\n'* ]]; then
		printf '%s' "${response_text#*$'\n\n'}"
	fi
}

# compact_payload <payload> — join the payload's lines and trim both ends.
#
# Compact without a jq process: valid JSON never carries a raw newline (they are
# escaped inside strings), so joining the lines is lossless.
compact_payload() {
	local payload="${1-}"
	payload="${payload//$'\r'/}"
	payload="${payload//$'\n'/ }"
	payload="${payload#"${payload%%[![:space:]]*}"}"
	payload="${payload%"${payload##*[![:space:]]}"}"
	printf '%s' "$payload"
}

# parse_http_response <method> <path> <response-text> <gh-exit-code>
#
# stdout: the gateway response; exit 0 for every HTTP answer, including 4xx/5xx.
# exit 1 only when there is no response to parse (or a body that is not even
# JSON-shaped): the audit stops rather than reporting a verdict from evidence it
# cannot read. <method> and <path> are only used in those messages.
parse_http_response() {
	local method="${1-}" path="${2-}" response_text="${3-}" gh_rc="${4:-0}"
	local status payload

	if ! status=$(split_status_line "$response_text") || [[ -z "$status" ]]; then
		printf 'gateway: no HTTP response for %s %s (gh exit %s)\n' "$method" "$path" "$gh_rc" >&2
		cat "${GBPC_GATEWAY_ERR:-/dev/null}" >&2
		return 1
	fi

	payload=$(compact_payload "$(response_payload "$response_text")")

	if [[ -z "$payload" ]]; then
		printf '{"status":%s,"body":null}\n' "$status"
		return 0
	fi

	# A JSON body starts with one of these tokens; anything else (an HTML error
	# page, a proxy banner) is not worth passing on to the rules. Full structural
	# validation belongs to the jq consumer, which exits 2 instead of reporting a
	# verdict from evidence it cannot parse.
	local json_shape='^(\{|\[|"|[0-9-]|true$|false$|null$)'
	if [[ ! "$payload" =~ $json_shape ]]; then
		printf 'gateway: response body for %s %s is not JSON\n' "$method" "$path" >&2
		printf '%s\n' "$response_text" >&2
		return 1
	fi

	printf '{"status":%s,"body":%s}\n' "$status" "$payload"
}
