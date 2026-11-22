#!/usr/bin/env bash
# run-case.sh <case-slice> — run one slice of the shell suite in its own process.
#
# tests/scripts.test.sh starts one of these per slice so they run concurrently;
# each gets a private temp workspace, gh log, response plan and state directory
# from tests/lib/harness.sh.
set -uo pipefail

SLICE="${1:-}"
if [[ -z "$SLICE" || ! -f "$SLICE" ]]; then
	printf 'run-case: missing or unknown case slice "%s"\n' "$SLICE" >&2
	exit 64
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$HERE/../.." && pwd)"
export SKILL_DIR

# shellcheck source=harness.sh
source "$HERE/harness.sh"
# shellcheck disable=SC1090
source "$SLICE"

finish
