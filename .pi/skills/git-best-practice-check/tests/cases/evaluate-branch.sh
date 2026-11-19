#!/usr/bin/env bash
# evaluate-branch.sh — Phase 1, branch-protection rules.
#
# Classic protection and repo rulesets are two carriers of the same practice, so
# every case here is about which evidence may be believed: a ruleset counts as
# protection, a permission gap is `unknown` (never "unprotected"), and required
# checks are read from `checks[]` as well as the legacy `contexts`.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/evaluate-harness.sh
source "$HERE/../lib/evaluate-harness.sh"

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

finish
