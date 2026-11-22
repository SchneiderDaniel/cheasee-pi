#!/usr/bin/env bash
# remediate-verify.sh — the re-audit contract.
#
# `reaudit` runs before every write (so a practice that changed underneath the
# user's answer is never overwritten) and again after it (so success is only
# reported when the fresh evidence says so).

# reaudit <check-id> — prints the audit JSON array for one check.
reaudit() {
	local id="$1" out rc=0
	local -a args=(--json --check "$id" --repo "$REPO")
	if [[ -n "$SETTINGS" ]]; then
		args+=(--settings "$SETTINGS")
	fi
	out=$(bash "$AUDIT" "${args[@]}") || rc=$?
	if [[ -z "$out" ]]; then
		printf 'remediate: audit produced no output for %s (exit %s)\n' "$id" "$rc" >&2
		return 1
	fi
	printf '%s' "$out"
}

# verify <check-id> — re-audit after the write and report the transition.
verify() {
	local id="$1" refreshed status
	STEP="re-verify"
	if ! refreshed=$(reaudit "$id"); then
		return 1
	fi
	status=$(jq -r '.[0].status // "unknown"' <<<"$refreshed")
	if [[ "$status" == "pass" ]]; then
		printf '%s: fail → pass\n' "$id"
		return 0
	fi
	if [[ "$status" == "pending" ]]; then
		printf '%s: fail → pending (accepted by GitHub, not effective yet; re-run the audit to confirm)\n' "$id"
		return 0
	fi
	case "$id" in
	community-*)
		# Community files land through a pull request, so the practice only
		# turns green after a human merges it. Pending is the honest state;
		# reporting success here would be a lie.
		printf '%s: fail → pending (pull request opened; merge it to make the practice pass)\n' "$id"
		return 0
		;;
	esac
	printf 'remediate: re-verify failed for %s (step: %s, status: %s)\n' "$id" "$STEP" "$status" >&2
	return 1
}
