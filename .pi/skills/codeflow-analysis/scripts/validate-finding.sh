#!/usr/bin/env bash
# Verify one CodeFlow finding with a read-only pi subagent.
#
# Usage: validate-finding.sh <finding.md> [repo-root]
#        validate-finding.sh --self-test
#
# Prints the subagent's verdict block. Exit 0 = VALID, 1 = INVALID,
# 2 = bad usage / missing file, 3 = subagent failed or printed no verdict.

set -uo pipefail

parse_verdict() {
	awk '/^VERDICT:/ { print $2; exit }' <<<"$1"
}

if [ "${1:-}" = "--self-test" ]; then
	fail=0
	check() { [ "$(parse_verdict "$2")" = "$3" ] || { echo "FAIL: $1 (got '$(parse_verdict "$2")')" >&2; fail=1; }; }
	check "valid" "blah
VERDICT: VALID
EVIDENCE: a.ts:1" "VALID"
	check "invalid" "VERDICT: INVALID
REASON: nope" "INVALID"
	check "missing" "no verdict here" ""
	[ "$fail" = 0 ] && echo "self-test OK"
	exit "$fail"
fi

finding="${1:-}"
if [ -z "$finding" ] || [ ! -f "$finding" ]; then
	echo "usage: $(basename "$0") <finding.md> [repo-root]" >&2
	exit 2
fi

repo_root="${2:-$(git rev-parse --show-toplevel 2>/dev/null)}"
if [ -z "$repo_root" ] || [ ! -d "$repo_root/.pi/extensions/ripgrep-search" ]; then
	echo "repo root not found (need <root>/.pi/extensions/ripgrep-search): '$repo_root'" >&2
	exit 2
fi
skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Inherit the caller's model: without --model the subagent resolves the stored
# default, which can hit a different (unfunded) provider than this session.
model_args=()
[ -n "${PI_MODEL:-}" ] && model_args=(--model "${PI_PROVIDER:+$PI_PROVIDER/}$PI_MODEL")

verdict_file="$(mktemp)"
trap 'rm -f "$verdict_file"' EXIT INT TERM
if ! timeout 600 pi -p \
	--no-extensions \
	"${model_args[@]+"${model_args[@]}"}" \
	-e "$repo_root/.pi/extensions/ripgrep-search/index.ts" \
	-e "$repo_root/.pi/extensions/structural-analyzer/index.ts" \
	--tools read,ripgrep_search,structural_search \
	--no-skills --no-context-files \
	--append-system-prompt "$skill_dir/references/finding-validator.md" \
	-- "Verify this CodeFlow finding:

$(cat "$finding")" >"$verdict_file" 2>&1; then
	echo "validator subagent failed (exit $?) — output:" >&2
	cat "$verdict_file" >&2
	exit 3
fi

out="$(cat "$verdict_file")"
printf '%s\n' "$out"

verdict="$(parse_verdict "$out")"
case "$verdict" in
VALID) exit 0 ;;
INVALID) exit 1 ;;
*)
	echo "no VERDICT line in validator output" >&2
	exit 3
	;;
esac
