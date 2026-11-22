#!/usr/bin/env bash
# evaluate-contract.sh — Phase 1, the invariants that hold across every rule.
#
# `remediable` is the contract the consent loop depends on (true only for
# `fail`), and the purity cases prove the filter has no hidden inputs: the same
# evidence always yields byte-identical output, with `gh` off PATH and the
# GitHub tokens unset.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/evaluate-harness.sh
source "$HERE/../lib/evaluate-harness.sh"

# --------------------------------------------------------------------------
# remediable flag
# --------------------------------------------------------------------------
check "remediable is false for pass" dependabot-alerts \
	"{$CTX,\"vulnerability_alerts\":{\"status\":204,\"body\":null}}"
expect_field '.remediable' false

check "remediable is true for fail" dependabot-alerts \
	"{$CTX,\"vulnerability_alerts\":{\"status\":404,\"body\":null}}"
expect_field '.remediable' true

check "remediable is false for pending" code-scanning \
	"{
	$CTX,
	\"default_setup\":{\"status\":200,\"body\":{\"state\":\"configured\"}},
	\"analyses\":{\"status\":200,\"body\":[]}}"
expect_field '.remediable' false

check "remediable is false for not-available" code-scanning \
	"{
	$CTX,
	\"default_setup\":{\"status\":403,\"body\":null},
	\"analyses\":{\"status\":403,\"body\":null}}"
expect_field '.remediable' false

check "remediable is false for unknown" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":404,\"body\":null},
	\"rules\":{\"status\":403,\"body\":null}}"
expect_field '.remediable' false

check "practice label is populated" community-readme \
	"{
	$CTX,
	\"profile\":{\"status\":200,\"body\":{\"health_percentage\":0,\"files\":{\"readme\":null}}},
	\"probes\":[{\"path\":\"README.md\",\"status\":404,\"body\":null}]}"
expect_field '.id' 'community-readme'

# --------------------------------------------------------------------------
# determinism / purity
# --------------------------------------------------------------------------
DETERMINISM_EV="{
$CTX,
\"protection\":{\"status\":404,\"body\":null},
\"rules\":{\"status\":200,\"body\":[{\"type\":\"pull_request\",\"enforcement\":\"active\",\"parameters\":{\"required_approving_review_count\":1,\"required_status_checks\":[{\"context\":\"b\"},{\"context\":\"a\"}]},\"bypass_actors\":[]}]}}"

CASES=$((CASES + 1))
CUR="determinism: identical output on repeated evaluation"
first=$(printf '%s' "$DETERMINISM_EV" | evaluate branch-protection)
second=$(printf '%s' "$DETERMINISM_EV" | evaluate branch-protection)
if [[ "$first" == "$second" ]]; then
	ok "$CUR"
else
	nok "$CUR: $first != $second"
fi

CASES=$((CASES + 1))
CUR="purity: identical output with gh off PATH and tokens unset"
PURE_BIN=$(mktemp -d)
ln -s "$(command -v jq)" "$PURE_BIN/jq"
# shellcheck disable=SC2086
pure=$(printf '%s' "$DETERMINISM_EV" | env -u GH_TOKEN -u GITHUB_TOKEN -u GH_HOST PATH="$PURE_BIN" jq -c -f "$EVALUATE" --arg id branch-protection --argjson now "$TEST_NOW")
rm -rf "$PURE_BIN"
if [[ "$pure" == "$first" ]]; then
	ok "$CUR"
else
	nok "$CUR: $pure != $first"
fi

finish
