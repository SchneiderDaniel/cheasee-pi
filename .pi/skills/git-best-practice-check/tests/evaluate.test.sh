#!/usr/bin/env bash
# Phase 1 — evaluate.jq is a pure function: evidence JSON in, check JSON out.
#
# Every case here supplies the evidence bundle that audit.sh would have gathered
# and asserts on the status plus the human-readable evidence strings. Nothing in
# this file touches `gh`, the network, or the filesystem beyond a temp bin dir.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVALUATE="$SKILL_DIR/scripts/evaluate.jq"

CASES=0
FAILS=0
CUR=""
OUT=""

ok() { printf 'ok - %s\n' "$*"; }
nok() {
	printf 'not ok - %s\n' "$*" >&2
	FAILS=$((FAILS + 1))
}

# Fixed clock: evaluate.jq never reads one, audit.sh passes `--argjson now`.
TEST_NOW=1760000000
iso() { jq -n -r --argjson t "$1" '$t | todate'; } # epoch seconds -> ISO8601
ago() { printf '%s' "$((TEST_NOW - $1 * 86400))"; } # epoch seconds, N days back
evaluate() { # <id>, evidence on stdin
	jq -c -f "$EVALUATE" --arg id "$1" --argjson now "$TEST_NOW"
}
evaluate_without_clock() { # <id>, evidence on stdin — same call, no `now`
	jq -c -f "$EVALUATE" --arg id "$1"
}

check() { # <name> <id> <evidence-json>
	CUR="$1"
	CASES=$((CASES + 1))
	if ! OUT=$(printf '%s' "$3" | evaluate "$2"); then
		nok "$CUR: evaluate.jq exited non-zero"
		OUT='{}'
	fi
}

expect_status() { # <want>
	local got
	got=$(jq -r '.status // "missing"' <<<"$OUT")
	if [[ "$got" == "$1" ]]; then
		ok "$CUR → $1"
	else
		nok "$CUR: expected status $1, got $got: $OUT"
	fi
}

expect_evidence() { # <substring>
	local joined
	joined=$(jq -r '.evidence | join(" ; ")' <<<"$OUT" 2>/dev/null || printf '<none>')
	if [[ "$joined" == *"$1"* ]]; then
		ok "$CUR evidence ~ $1"
	else
		nok "$CUR: evidence does not mention '$1' (got: $joined)"
	fi
}

expect_field() { # <jq path> <want>
	local got
	got=$(jq -r "$1 | tostring" <<<"$OUT" 2>/dev/null || printf '<missing>')
	if [[ "$got" == "$2" ]]; then
		ok "$CUR $1 = $2"
	else
		nok "$CUR: $1 expected $2, got $got"
	fi
}

CTX='"slug":"owner/repo","default_branch":"main"'

# --------------------------------------------------------------------------
# branch-protection
# --------------------------------------------------------------------------
check "classic protection, 1 reviewer, admins enforced" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":200,\"body\":{
		\"required_pull_request_reviews\":{\"required_approving_review_count\":1},
		\"enforce_admins\":{\"enabled\":true},
		\"required_status_checks\":null,
		\"restrictions\":null}},
	\"rules\":{\"status\":404,\"body\":null}}"
expect_status pass
expect_evidence "required_approving_review_count=1"
expect_evidence "enforce_admins.enabled=true"

check "classic protection, 0 reviewers" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":200,\"body\":{
		\"required_pull_request_reviews\":{\"required_approving_review_count\":0},
		\"enforce_admins\":{\"enabled\":true}}},
	\"rules\":{\"status\":404,\"body\":null}}"
expect_status fail
expect_evidence "required_approving_review_count=0"

check "classic protection, admins exempt, no covering ruleset" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":200,\"body\":{
		\"required_pull_request_reviews\":{\"required_approving_review_count\":1},
		\"enforce_admins\":{\"enabled\":false}}},
	\"rules\":{\"status\":404,\"body\":null}}"
expect_status fail
expect_evidence "admins exempt"

check "ruleset provides protection (classic 404)" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":404,\"body\":null},
	\"rules\":{\"status\":200,\"body\":[{
		\"type\":\"pull_request\",\"enforcement\":\"active\",
		\"parameters\":{\"required_approving_review_count\":1,\"dismiss_stale_reviews\":true},
		\"bypass_actors\":[]}]}}"
expect_status pass
expect_evidence "ruleset"
expect_evidence "required_approving_review_count=1"

check "ruleset with admin bypass actors" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":404,\"body\":null},
	\"rules\":{\"status\":200,\"body\":[{
		\"type\":\"pull_request\",\"enforcement\":\"active\",
		\"parameters\":{\"required_approving_review_count\":1},
		\"bypass_actors\":[{\"actor_id\":5,\"actor_type\":\"OrganizationAdmin\",\"bypass_mode\":\"always\"}]}]}}"
expect_status fail
expect_evidence "OrganizationAdmin"

check "no protection at all (404 + 404)" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":404,\"body\":null},
	\"rules\":{\"status\":404,\"body\":null}}"
expect_status fail

check "rules endpoint forbidden is unknown, not unprotected" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":404,\"body\":null},
	\"rules\":{\"status\":403,\"body\":null}}"
expect_status unknown

check "required checks only in checks[]" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":200,\"body\":{
		\"required_pull_request_reviews\":{\"required_approving_review_count\":1},
		\"enforce_admins\":{\"enabled\":true},
		\"required_status_checks\":{\"strict\":true,\"contexts\":[],\"checks\":[{\"context\":\"ci/test\",\"app_id\":-1}]}}},
	\"rules\":{\"status\":404,\"body\":null}}"
expect_status pass
expect_evidence "ci/test"

check "legacy contexts-only required checks" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":200,\"body\":{
		\"required_pull_request_reviews\":{\"required_approving_review_count\":1},
		\"enforce_admins\":{\"enabled\":true},
		\"required_status_checks\":{\"strict\":true,\"contexts\":[\"ci/legacy\"],\"checks\":[]}}},
	\"rules\":{\"status\":404,\"body\":null}}"
expect_status pass
expect_evidence "ci/legacy"

# --------------------------------------------------------------------------
# dependabot-alerts
# --------------------------------------------------------------------------
check "vulnerability-alerts 204" dependabot-alerts \
	"{$CTX,\"vulnerability_alerts\":{\"status\":204,\"body\":null}}"
expect_status pass

check "vulnerability-alerts 404" dependabot-alerts \
	"{$CTX,\"vulnerability_alerts\":{\"status\":404,\"body\":{\"message\":\"Not Found\"}}}"
expect_status fail
expect_evidence "404"

check "vulnerability-alerts 403 is not-available" dependabot-alerts \
	"{$CTX,\"vulnerability_alerts\":{\"status\":403,\"body\":{\"message\":\"Forbidden\"}}}"
expect_status not-available

# --------------------------------------------------------------------------
# secret-scanning
# --------------------------------------------------------------------------
check "secret scanning enabled" secret-scanning \
	"{
	$CTX,
	\"repo\":{\"status\":200,\"body\":{\"security_and_analysis\":{\"secret_scanning\":{\"status\":\"enabled\"}}}}}"
expect_status pass
expect_evidence "secret_scanning.status=enabled"

check "secret scanning disabled" secret-scanning \
	"{
	$CTX,
	\"repo\":{\"status\":200,\"body\":{\"security_and_analysis\":{\"secret_scanning\":{\"status\":\"disabled\"}}}}}"
expect_status fail
expect_evidence "secret_scanning.status=disabled"

check "secret scanning key absent means not configured" secret-scanning \
	"{
	$CTX,
	\"repo\":{\"status\":200,\"body\":{\"security_and_analysis\":{}}}}"
expect_status fail

check "secret scanning 403 is not-available" secret-scanning \
	"{$CTX,\"repo\":{\"status\":403,\"body\":{\"message\":\"Forbidden\"}}}"
expect_status not-available

# --------------------------------------------------------------------------
# code-scanning
# --------------------------------------------------------------------------
check "default setup configured with a completed run" code-scanning \
	"{
	$CTX,
	\"default_setup\":{\"status\":200,\"body\":{\"state\":\"configured\"}},
	\"analyses\":{\"status\":200,\"body\":[{\"id\":1,\"state\":\"completed\"}]}}"
expect_status pass
expect_evidence "state=configured"

check "default setup configured, no runs yet" code-scanning \
	"{
	$CTX,
	\"default_setup\":{\"status\":200,\"body\":{\"state\":\"configured\"}},
	\"analyses\":{\"status\":200,\"body\":[]}}"
expect_status pending

check "default setup not configured" code-scanning \
	"{
	$CTX,
	\"default_setup\":{\"status\":200,\"body\":{\"state\":\"not-configured\"}},
	\"analyses\":{\"status\":200,\"body\":[]}}"
expect_status fail

# Workflow mode: default setup off, one analysis shifted <days> back, stamping
# <created_at|updated_at>.
workflow_ev() {
	printf '{%s,"default_setup":{"status":200,"body":{"state":"not-configured"}},"analyses":{"status":200,"body":[{"id":7,"state":"completed","%s":"%s"}]}}' \
		"$CTX" "${2:-created_at}" "$(iso "$(ago "$1")")"
}

check "default setup not configured but a scanning workflow has uploaded analyses" code-scanning \
	"$(workflow_ev 3)"
expect_status pass
expect_evidence "completed analyses=1"
expect_evidence "workflow"

check "default setup not configured and only stale analyses (400 days)" code-scanning \
	"$(workflow_ev 400)"
expect_status fail
expect_evidence "400 days old"
expect_evidence "not-configured"

check "default setup not configured, analyses at the edge of the window (89 days)" code-scanning \
	"$(workflow_ev 89 updated_at)"
expect_status pass

check "default setup not configured and analyses without any timestamp" code-scanning \
	"{
	$CTX,
	\"default_setup\":{\"status\":200,\"body\":{\"state\":\"not-configured\"}},
	\"analyses\":{\"status\":200,\"body\":[{\"id\":7,\"state\":\"completed\"}]}}"
expect_status unknown
expect_evidence "without a usable timestamp"

check "default setup configured with a stale run still passes (setup is on)" code-scanning \
	"{
	$CTX,
	\"default_setup\":{\"status\":200,\"body\":{\"state\":\"configured\"}},
	\"analyses\":{\"status\":200,\"body\":[{\"id\":1,\"state\":\"completed\",\"created_at\":\"$(iso "$(ago 200)")\"}]}}"
expect_status pass
expect_evidence "200 days old"

check "default setup 403 is not-available" code-scanning \
	"{
	$CTX,
	\"default_setup\":{\"status\":403,\"body\":{\"message\":\"GitHub Advanced Security is not enabled for this repository\"}},
	\"analyses\":{\"status\":403,\"body\":null}}"
expect_status not-available

# --------------------------------------------------------------------------
# community standards
# --------------------------------------------------------------------------
ALL_MISSING_PROFILE='{"status":200,"body":{"health_percentage":0,"files":{"readme":null,"code_of_conduct":null,"contributing":null,"license":null,"issue_template":null,"pull_request_template":null}}}'

check "community: README missing" community-readme \
	"{
	$CTX,
	\"profile\":$ALL_MISSING_PROFILE,
	\"probes\":[{\"path\":\"README.md\",\"status\":404,\"body\":null},{\"path\":\"docs/README.md\",\"status\":404,\"body\":null}]}"
expect_status fail
expect_evidence "community/profile files.readme = null"

check "community: README reported null but symlink found" community-readme \
	"{
	$CTX,
	\"profile\":$ALL_MISSING_PROFILE,
	\"probes\":[{\"path\":\"README.md\",\"status\":200,\"body\":{\"type\":\"symlink\",\"target\":\"docs/README.md\"}}]}"
expect_status pass
expect_evidence "docs/README.md"

check "community: code of conduct present in profile" community-code-of-conduct \
	"{
	$CTX,
	\"profile\":{\"status\":200,\"body\":{\"health_percentage\":87,\"files\":{\"code_of_conduct\":{\"path\":\"CODE_OF_CONDUCT.md\"}}}},
	\"probes\":[]}"
expect_status pass

check "community: contributing missing" community-contributing \
	"{
	$CTX,
	\"profile\":$ALL_MISSING_PROFILE,
	\"probes\":[{\"path\":\"CONTRIBUTING.md\",\"status\":404,\"body\":null},{\"path\":\".github/CONTRIBUTING.md\",\"status\":404,\"body\":null}]}"
expect_status fail
expect_evidence "CONTRIBUTING.md -> 404"

check "community: license missing" community-license \
	"{
	$CTX,
	\"profile\":$ALL_MISSING_PROFILE,
	\"probes\":[{\"path\":\"LICENSE\",\"status\":404,\"body\":null}]}"
expect_status fail

check "community: issue templates missing" community-issue-templates \
	"{
	$CTX,
	\"profile\":$ALL_MISSING_PROFILE,
	\"probes\":[{\"path\":\".github/ISSUE_TEMPLATE\",\"status\":404,\"body\":null}]}"
expect_status fail

check "community: pull request template missing" community-pull-request-template \
	"{
	$CTX,
	\"profile\":$ALL_MISSING_PROFILE,
	\"probes\":[{\"path\":\".github/PULL_REQUEST_TEMPLATE.md\",\"status\":404,\"body\":null}]}"
expect_status fail

check "security policy at root" community-security-policy \
	"{
	$CTX,
	\"profile\":$ALL_MISSING_PROFILE,
	\"probes\":[
		{\"path\":\"SECURITY.md\",\"status\":200,\"body\":{\"type\":\"file\"}},
		{\"path\":\".github/SECURITY.md\",\"status\":404,\"body\":null},
		{\"path\":\"docs/SECURITY.md\",\"status\":404,\"body\":null}]}"
expect_status pass

check "security policy under .github" community-security-policy \
	"{
	$CTX,
	\"profile\":$ALL_MISSING_PROFILE,
	\"probes\":[
		{\"path\":\"SECURITY.md\",\"status\":404,\"body\":null},
		{\"path\":\".github/SECURITY.md\",\"status\":200,\"body\":{\"type\":\"file\"}},
		{\"path\":\"docs/SECURITY.md\",\"status\":404,\"body\":null}]}"
expect_status pass

check "security policy under docs" community-security-policy \
	"{
	$CTX,
	\"profile\":$ALL_MISSING_PROFILE,
	\"probes\":[
		{\"path\":\"SECURITY.md\",\"status\":404,\"body\":null},
		{\"path\":\".github/SECURITY.md\",\"status\":404,\"body\":null},
		{\"path\":\"docs/SECURITY.md\",\"status\":200,\"body\":{\"type\":\"file\"}}]}"
expect_status pass

check "security policy absent everywhere" community-security-policy \
	"{
	$CTX,
	\"profile\":$ALL_MISSING_PROFILE,
	\"probes\":[
		{\"path\":\"SECURITY.md\",\"status\":404,\"body\":null},
		{\"path\":\".github/SECURITY.md\",\"status\":404,\"body\":null},
		{\"path\":\"docs/SECURITY.md\",\"status\":404,\"body\":null}]}"
expect_status fail
expect_evidence "SECURITY.md -> 404"
expect_evidence ".github/SECURITY.md -> 404"
expect_evidence "docs/SECURITY.md -> 404"

check "health_percentage 100 is not a proxy for SECURITY.md" community-security-policy \
	"{
	$CTX,
	\"profile\":{\"status\":200,\"body\":{\"health_percentage\":100,\"files\":{
		\"readme\":{\"path\":\"README.md\"},\"code_of_conduct\":{\"path\":\"CODE_OF_CONDUCT.md\"},
		\"contributing\":{\"path\":\"CONTRIBUTING.md\"},\"license\":{\"path\":\"LICENSE\"},
		\"issue_template\":{\"path\":\".github/ISSUE_TEMPLATE/bug_report.md\"},
		\"pull_request_template\":{\"path\":\".github/PULL_REQUEST_TEMPLATE.md\"}}}},
	\"probes\":[{\"path\":\"SECURITY.md\",\"status\":404,\"body\":null}]}"
expect_status fail

check "fork: community/profile 404 falls back to contents" community-contributing \
	"{
	$CTX,
	\"profile\":{\"status\":404,\"body\":{\"message\":\"Not Found\"}},
	\"probes\":[{\"path\":\"CONTRIBUTING.md\",\"status\":200,\"body\":{\"type\":\"file\"}}]}"
expect_status pass

check "permission gap on contents probe is unknown" community-contributing \
	"{
	$CTX,
	\"profile\":{\"status\":404,\"body\":null},
	\"probes\":[{\"path\":\"CONTRIBUTING.md\",\"status\":403,\"body\":null}]}"
expect_status unknown

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
	\"profile\":$ALL_MISSING_PROFILE,
	\"probes\":[{\"path\":\"README.md\",\"status\":404,\"body\":null}]}"
expect_field '.id' 'community-readme'

# code-scanning recency: the window is an input, never a clock read
CASES=$((CASES + 1))
CUR="code scanning: workflow analyses are unknown when no clock is supplied"
if OUT=$(workflow_ev 400 | evaluate_without_clock code-scanning); then
	expect_status unknown
else
	nok "$CUR: evaluate.jq exited non-zero"
fi

CASES=$((CASES + 1))
CUR="code scanning: the same evidence with a clock is fail (recency is the only difference)"
if OUT=$(workflow_ev 400 | evaluate code-scanning); then
	expect_status fail
else
	nok "$CUR: evaluate.jq exited non-zero"
fi

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

# --------------------------------------------------------------------------
printf '\n%d cases, %d failures\n' "$CASES" "$FAILS"
((FAILS == 0)) || exit 1
