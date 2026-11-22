#!/usr/bin/env bash
# report.sh — renders audit rows as the human table SKILL.md asks for.
# Reads a JSON array via the first argument; issues no requests.

# print_table <rows-json>
#
# One jq pass emits the per-row columns followed by the summary as the last
# line: rendering the rows one jq call at a time made the report the slowest
# part of an audit, and a second call for the summary doubled that.
print_table() {
	local rows="$1" rendered summary row_lines
	if ! rendered=$(jq -r '
		(.[] | [
			.id,
			.status,
			(if (.evidence | length) > 0 then (.evidence | join("; ")) else "-" end)
		] | @tsv),
		("summary: " + (group_by(.status) | map("\(.[0].status)=\(length)") | join(" ")))' <<<"$rows"); then
		printf 'audit: cannot render the report from the audit rows\n' >&2
		return 1
	fi
	summary="${rendered##*$'\n'}"
	row_lines="${rendered%$'\n'*}"

	printf '%-36s %-14s %s\n' "CHECK" "STATUS" "EVIDENCE"
	local id status evidence
	while IFS=$'\t' read -r id status evidence; do
		[[ -z "$id" ]] && continue
		printf '%-36s %-14s %s\n' "$id" "$status" "$evidence"
	done <<<"$row_lines"
	printf '\n'
	printf '%s\n' "$summary"
}
