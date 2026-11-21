#!/usr/bin/env bash
# evaluate-security.sh — Phase 1, the three security-feature rules.
#
# Dependabot alerts, secret scanning and code scanning each answer with a
# different signal (a bare status, a settings object, a setup state plus an
# analyses list), and each can be gated by plan or token. Every case therefore
# asserts both the verdict and that a gap is never read as "disabled".
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/evaluate-harness.sh
source "$HERE/../lib/evaluate-harness.sh"

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

# Regression: the analyses response has its own status. Default setup off plus an
# unreadable analyses list is a permission/plan gap, never "zero analyses" — a
# `fail` there would offer a setup change the user cannot make.
check "default setup not configured and analyses 403 is unknown, not fail" code-scanning \
	"{
	$CTX,
	\"default_setup\":{\"status\":200,\"body\":{\"state\":\"not-configured\"}},
	\"analyses\":{\"status\":403,\"body\":{\"message\":\"Resource not accessible by integration\"}}}"
expect_status unknown
expect_evidence "analyses -> 403"
expect_evidence "not treated as empty"
expect_field '.remediable' false

check "default setup not configured and analyses 404 is not-available, not fail" code-scanning \
	"{
	$CTX,
	\"default_setup\":{\"status\":200,\"body\":{\"state\":\"not-configured\"}},
	\"analyses\":{\"status\":404,\"body\":null}}"
expect_status not-available
expect_evidence "analyses -> 404"
expect_field '.remediable' false

check "default setup configured stays pass even when analyses 403" code-scanning \
	"{
	$CTX,
	\"default_setup\":{\"status\":200,\"body\":{\"state\":\"configured\"}},
	\"analyses\":{\"status\":403,\"body\":null}}"
expect_status pass
expect_evidence "state=configured (default setup is on)"

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

finish
