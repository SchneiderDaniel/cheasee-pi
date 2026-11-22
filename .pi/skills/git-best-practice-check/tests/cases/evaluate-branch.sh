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

# Same policy on the ruleset-only branch: a non-admin bypass actor is not an
# admin exemption (it is still named in the evidence), while an admin one fails.
check "ruleset-only protection with a non-admin bypass actor" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":404,\"body\":null},
	\"rules\":{\"status\":200,\"body\":[{
		\"type\":\"pull_request\",\"enforcement\":\"active\",
		\"parameters\":{\"required_approving_review_count\":1},
		\"bypass_actors\":[{\"actor_id\":7,\"actor_type\":\"DeployKey\",\"bypass_mode\":\"always\"}]}]}}"
expect_status pass
expect_evidence "DeployKey"

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

# Audit regression: classic protection can look perfect (1 reviewer, admins
# enforced) while an active ruleset hands admins a bypass, so the classic-200
# path must read the effective rules too.
check "classic protection + ruleset OrganizationAdmin bypass" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":200,\"body\":{
		\"required_pull_request_reviews\":{\"required_approving_review_count\":1},
		\"enforce_admins\":{\"enabled\":true},
		\"required_status_checks\":null,
		\"restrictions\":null}},
	\"rules\":{\"status\":200,\"body\":[{
		\"type\":\"pull_request\",\"enforcement\":\"active\",
		\"parameters\":{\"required_approving_review_count\":1},
		\"bypass_actors\":[{\"actor_id\":5,\"actor_type\":\"OrganizationAdmin\",\"bypass_mode\":\"always\"}]}]}}"
expect_status fail
expect_evidence "OrganizationAdmin"
expect_evidence "admins exempt"

check "classic protection + ruleset RepositoryRole admin bypass" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":200,\"body\":{
		\"required_pull_request_reviews\":{\"required_approving_review_count\":1},
		\"enforce_admins\":{\"enabled\":true}}},
	\"rules\":{\"status\":200,\"body\":[{
		\"type\":\"pull_request\",\"enforcement\":\"active\",
		\"parameters\":{\"required_approving_review_count\":1},
		\"bypass_actors\":[{\"actor_id\":5,\"actor_type\":\"RepositoryRole\",\"bypass_mode\":\"always\"}]}]}}"
expect_status fail
expect_evidence "RepositoryRole"

# An approval-gated bypass keeps the review requirement, and a non-admin bypass
# is not an admin exemption: both pass, with the actors named as evidence.
check "classic protection + approval-gated admin bypass" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":200,\"body\":{
		\"required_pull_request_reviews\":{\"required_approving_review_count\":1},
		\"enforce_admins\":{\"enabled\":true}}},
	\"rules\":{\"status\":200,\"body\":[{
		\"type\":\"pull_request\",\"enforcement\":\"active\",
		\"parameters\":{\"required_approving_review_count\":1},
		\"bypass_actors\":[{\"actor_id\":5,\"actor_type\":\"OrganizationAdmin\",\"bypass_mode\":\"pull_request\"}]}]}}"
expect_status pass
expect_evidence "bypass_mode=pull_request"

check "classic protection + non-admin ruleset bypass" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":200,\"body\":{
		\"required_pull_request_reviews\":{\"required_approving_review_count\":1},
		\"enforce_admins\":{\"enabled\":true}}},
	\"rules\":{\"status\":200,\"body\":[{
		\"type\":\"pull_request\",\"enforcement\":\"active\",
		\"parameters\":{\"required_approving_review_count\":1},
		\"bypass_actors\":[{\"actor_id\":7,\"actor_type\":\"DeployKey\",\"bypass_mode\":\"always\"}]}]}}"
expect_status pass
expect_evidence "DeployKey"

check "no protection at all (404 + 404)" branch-protection \	"{
	$CTX,
	\"protection\":{\"status\":404,\"body\":null},
	\"rules\":{\"status\":404,\"body\":null}}"
expect_status fail

# Audit regression: classic protection alone is not enough evidence. When the
# effective rules cannot be read (401/403), a ruleset could still exempt admins
# or relax the review count, so the verdict must be `unknown` — never `pass`.
check "classic protection + rules 403 is unknown, not pass" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":200,\"body\":{
		\"required_pull_request_reviews\":{\"required_approving_review_count\":1},
		\"enforce_admins\":{\"enabled\":true},
		\"required_status_checks\":null,
		\"restrictions\":null}},
	\"rules\":{\"status\":403,\"body\":null}}"
expect_status unknown
expect_evidence "cannot read the effective branch rules"
expect_evidence "enforce_admins.enabled=true"
expect_field .remediable false

check "classic protection + rules 401 is unknown, not pass" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":200,\"body\":{
		\"required_pull_request_reviews\":{\"required_approving_review_count\":1},
		\"enforce_admins\":{\"enabled\":true}}},
	\"rules\":{\"status\":401,\"body\":null}}"
expect_status unknown
expect_evidence "cannot read the effective branch rules"

# Same gap on the admins-exempt path: without the effective rules there is no
# evidence for "no covering ruleset rule", so it is unknown, not fail.
check "classic admins exempt + rules 403 is unknown, not fail" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":200,\"body\":{
		\"required_pull_request_reviews\":{\"required_approving_review_count\":1},
		\"enforce_admins\":{\"enabled\":false}}},
	\"rules\":{\"status\":403,\"body\":null}}"
expect_status unknown
expect_evidence "cannot read the effective branch rules"

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

# Classic protection exempts admins, but an active ruleset covers them and its
# bypass is approval-gated: the review requirement still applies, so this passes.
check "admins exempt by classic, covered by a ruleset rule" branch-protection \
	"{
	$CTX,
	\"protection\":{\"status\":200,\"body\":{
		\"required_pull_request_reviews\":{\"required_approving_review_count\":1},
		\"enforce_admins\":{\"enabled\":false}}},
	\"rules\":{\"status\":200,\"body\":[{
		\"type\":\"pull_request\",\"enforcement\":\"active\",
		\"parameters\":{\"required_approving_review_count\":2},
		\"bypass_actors\":[{\"actor_id\":5,\"actor_type\":\"OrganizationAdmin\",\"bypass_mode\":\"pull_request\"}]}]}}"
expect_status pass
expect_evidence "admins covered by an active ruleset rule"
expect_evidence "2 required review(s)"

finish
