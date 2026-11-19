#!/usr/bin/env bash
# Phase 1 — evaluate.jq is a pure function: evidence JSON in, check JSON out.
#
# The cases live in tests/cases/evaluate-*.sh, one slice per rule family, and
# each slice runs in its own process: they share no state, and every jq start-up
# costs milliseconds, so running them concurrently keeps this suite inside its
# runtime budget. The shared assertions are in tests/lib/evaluate-harness.sh.
#
# Nothing here touches `gh`, the network, or the filesystem beyond the temp bin
# dir a purity case creates.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SLICES=(
	"$HERE/cases/evaluate-branch.sh"
	"$HERE/cases/evaluate-security.sh"
	"$HERE/cases/evaluate-community.sh"
	"$HERE/cases/evaluate-contract.sh"
)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pids=()
for slice in "${SLICES[@]}"; do
	name=$(basename "$slice" .sh)
	bash "$slice" >"$WORK/$name.log" 2>&1 &
	pids+=($!)
done

rc=0
for pid in "${pids[@]}"; do
	wait "$pid" || rc=1
done

# Stable order: one slice's log cannot interleave with another's output.
total_cases=0
total_fails=0
for slice in "${SLICES[@]}"; do
	name=$(basename "$slice" .sh)
	cat "$WORK/$name.log"
	summary=$(tail -1 "$WORK/$name.log")
	if [[ "$summary" =~ ^([0-9]+)\ cases,\ ([0-9]+)\ failures$ ]]; then
		total_cases=$((total_cases + BASH_REMATCH[1]))
		total_fails=$((total_fails + BASH_REMATCH[2]))
	else
		printf 'evaluate: no summary line from the %s slice; it did not finish\n' "$name" >&2
		rc=1
	fi
done

printf '\n%d cases, %d failures\n' "$total_cases" "$total_fails"
((total_fails == 0 && rc == 0)) || exit 1
exit 0
