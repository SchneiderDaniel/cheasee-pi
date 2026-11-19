#!/usr/bin/env bash
# report.sh — renders audit rows as the human table SKILL.md asks for.
# Reads a JSON array on stdin via the first argument; issues no requests.

print_table() {
	local rows="$1" row
	printf '%-36s %-14s %s\n' "CHECK" "STATUS" "EVIDENCE"
	while IFS= read -r row; do
		printf '%-36s %-14s %s\n' \
			"$(jq -r '.id' <<<"$row")" \
			"$(jq -r '.status' <<<"$row")" \
			"$(jq -r 'if (.evidence | length) > 0 then (.evidence | join("; ")) else "-" end' <<<"$row")"
	done < <(jq -c '.[]' <<<"$rows")
	printf '\n'
	printf 'summary: %s\n' "$(jq -r 'group_by(.status) | map("\(.[0].status)=\(length)") | join(" ")' <<<"$rows")"
}
