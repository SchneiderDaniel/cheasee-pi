#!/usr/bin/env bash
# Phases 2, 3, 4, 6, 7 — adapters (repo resolution + gh gateway), audit.sh,
# remediate.sh, the maintainer journey, and the hygiene guards.
#
# The case slices live in tests/cases/ and each one runs in its own process
# (tests/lib/run-case.sh + tests/lib/harness.sh), in parallel: they never share
# state, and every spawn in these suites costs real wall-clock time on a machine
# where a single jq start-up is tens of milliseconds. This file only schedules
# them, prints their output in a stable order and aggregates the totals.
#
# Everything runs against tests/fixtures/fake-gh/gh: a stateful GitHub double
# that records every invocation in $GH_LOG and serves responses from a small
# state file plus an optional per-endpoint override plan. No network, no
# mutation of the real repository.
#
# Budget: the test plan gives this suite < 15s wall clock. It measures ~5s on an
# 8-core container, and the slices are already scheduled in parallel, so what
# moves this number is a subprocess added to the scripts or to the stub — a jq
# start-up per request, not the logic under test. tests/lib/harness.sh and the
# stub's fast paths exist for that reason; keep them in step with the shapes the
# audit actually requests.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$HERE/.." && pwd)"
RUNNER="$HERE/lib/run-case.sh"

SLICES=(
	"$HERE/cases/gateway.sh"
	"$HERE/cases/audit-basic.sh"
	"$HERE/cases/audit-cli.sh"
	"$HERE/cases/audit-checks.sh"
	"$HERE/cases/remediate-gate.sh"
	"$HERE/cases/remediate-writes.sh"
	"$HERE/cases/remediate-scanning.sh"
	"$HERE/cases/remediate-community.sh"
	"$HERE/cases/remediate-verify.sh"
	"$HERE/cases/journey.sh"
	"$HERE/cases/hygiene.sh"
)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pids=()
for slice in "${SLICES[@]}"; do
	name=$(basename "$slice" .sh)
	bash "$RUNNER" "$slice" >"$WORK/$name.log" 2>&1 &
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
		printf 'scripts: no summary line from the %s slice; it did not finish\n' "$name" >&2
		rc=1
	fi
done

printf '\n%d cases, %d failures\n' "$total_cases" "$total_fails"
((total_fails == 0 && rc == 0)) || exit 1
exit 0
