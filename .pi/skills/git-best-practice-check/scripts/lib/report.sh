#!/usr/bin/env bash
# report.sh — renders audit rows as the human table SKILL.md asks for.
# Reads a JSON array via the first argument; issues no requests.

# print_table <rows-json>
#
# One jq pass emits both the per-row columns and the summary: rendering eleven
# rows one jq call at a time made the report the slowest part of an audit.
print_table() {
	local rows="$1" rendered summary
	if ! rendered=$(jq -r '
		.[] | [
			.id,
			.status,
			(if (.evidence | length) > 0 then (.evidence | join("; ")) else "-" end)
		] | @tsv' <<<"$rows"); then
		printf 'audit: cannot render the report from the audit rows\n' >&2
		return 1
	fi
	if ! summary=$(jq -r 'group_by(.status) | map("\(.[0].status)=\(length)") | join(" ")' <<<"$rows"); then
		printf 'audit: cannot summarise the audit rows\n' >&2
		return 1
	fi

	printf '%-36s %-14s %s\n' "CHECK" "STATUS" "EVIDENCE"
	local id status evidence
	while IFS=$'\t' read -r id status evidence; do
		[[ -z "$id" ]] && continue
		printf '%-36s %-14s %s\n' "$id" "$status" "$evidence"
	done <<<"$rendered"
	printf '\n'
	printf 'summary: %s\n' "$summary"
}
