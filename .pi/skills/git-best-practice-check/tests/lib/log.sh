#!/usr/bin/env bash
# log.sh — the gh-log readers for the shell suites.
#
# Split from tests/lib/harness.sh to keep each harness module small. Every
# reader here uses shell builtins: they run on every assertion, and one
# awk/grep/wc per call was a measurable share of the suite's runtime. The log is
# tab-separated with no quoting in it, which is what makes that safe.
#
# Sourced by tests/lib/harness.sh; the slices never source it directly.

# The assertion helpers below read the gh log with shell builtins. They are
# called from every case, and one awk/grep/wc per call is a process the suite
# cannot afford: the log is tab-separated with no quoting in it.
log_count() {
	local _m _p _b n=0
	while IFS=$'\t' read -r _m _p _b; do n=$((n + 1)); done <"$GH_LOG"
	printf '%s' "$n"
}
log_methods() {
	local _m _p _b out=""
	while IFS=$'\t' read -r _m _p _b; do out+="$_m"$'\n'; done <"$GH_LOG"
	printf '%s' "$out"
}
log_paths() {
	local _m _p _b out=""
	while IFS=$'\t' read -r _m _p _b; do out+="$_m $_p"$'\n'; done <"$GH_LOG"
	printf '%s' "$out"
}
# log_path_has <fragment> — status only, so no output pipe can be closed early
# (`set -o pipefail` would otherwise turn a satisfied `| grep -q` into a failure).
log_path_has() {
	local _m _p _b
	while IFS=$'\t' read -r _m _p _b; do
		[[ "$_p" == *"$1"* ]] && return 0
	done <"$GH_LOG"
	return 1
}
write_lines() {
	local _m _p _b out=""
	while IFS=$'\t' read -r _m _p _b; do
		[[ "$_m" == "GET" ]] && continue
		out+="$_m $_p"$'\n'
	done <"$GH_LOG"
	printf '%s' "$out"
}
# write_lines_have <fragment> — status only, for the same reason as log_path_has.
write_lines_have() {
	local _m _p _b
	while IFS=$'\t' read -r _m _p _b; do
		[[ "$_m" == "GET" ]] && continue
		[[ "$_m $_p" == *"$1"* ]] && return 0
	done <"$GH_LOG"
	return 1
}
# count_write_lines <fragment> — how many non-GET requests match.
count_write_lines() {
	local _m _p _b n=0
	while IFS=$'\t' read -r _m _p _b; do
		[[ "$_m" == "GET" ]] && continue
		[[ "$_m $_p" == *"$1"* ]] && n=$((n + 1))
	done <"$GH_LOG"
	printf '%s' "$n"
}
write_count() {
	local _m _p _b n=0
	while IFS=$'\t' read -r _m _p _b; do
		[[ "$_m" == "GET" ]] && continue
		n=$((n + 1))
	done <"$GH_LOG"
	printf '%s' "$n"
}
body_of() { # <method> <path> -> request-body path of the first match
	local _m _p _b
	while IFS=$'\t' read -r _m _p _b; do
		if [[ "$_m" == "$1" && "$_p" == "$2" ]]; then
			printf '%s' "$_b"
			return 0
		fi
	done <"$GH_LOG"
	return 0
}
get_count() { # <path fragment> -> number of matching GET requests
	local _m _p _b n=0
	while IFS=$'\t' read -r _m _p _b; do
		if [[ "$_m" == "GET" && "$_p" == *"$1"* ]]; then n=$((n + 1)); fi
	done <"$GH_LOG"
	printf '%s' "$n"
}
argv_log() { cat "$GH_LOG.argv"; }

# status_of <check-id> / first_status — a row's status without a jq process.
# evaluate.jq emits compact rows in a fixed key order, so the status is the
# text between the id and the evidence array.
status_of() {
	local rest="${LAST_OUT#*\"id\":\"$1\"}"
	rest="${rest#*\"status\":\"}"
	printf '%s' "${rest%%\"*}"
}
first_status() {
	local rest="${LAST_OUT#*\"status\":\"}"
	printf '%s' "${rest%%\"*}"
}
