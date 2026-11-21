#!/usr/bin/env bash
# evaluate-community.sh — Phase 1, the seven community-standard rules.
#
# The community profile answers six of the seven from `files.*`, but it is a
# public-repo checklist, it refuses forks, and it has no security-policy field.
# These cases pin the fallbacks: contents probes (symlinks included), the fork
# path, and the gap status when a probe is forbidden.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/evaluate-harness.sh
source "$HERE/../lib/evaluate-harness.sh"

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

# A contents lookup for a directory answers with an array, not an object. The
# evidence line must not try to read `type` off it (indexing an array aborts the
# whole evaluation), and the practice still passes.
check "community: issue-template directory listing counts as present" community-issue-templates \
	"{
	$CTX,
	\"profile\":$ALL_MISSING_PROFILE,
	\"probes\":[{\"path\":\".github/ISSUE_TEMPLATE\",\"status\":200,\"body\":[{\"type\":\"file\",\"path\":\".github/ISSUE_TEMPLATE/bug_report.md\"}]}]}"
expect_status pass
expect_evidence ".github/ISSUE_TEMPLATE exists (a directory listing)"

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

finish
