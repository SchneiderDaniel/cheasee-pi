import { describe, it } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { type PortCall } from "../helper/mock-github-port.ts";

import type {
	SupervisorConfig,
	ProjectField,
	AgentRunResult,
	FilteredIssueData,
} from "../../config/types.ts";

import {
	calculateNextStatus,
	type StageState,
	type AuditGateContext,
	type GateRejected,
} from "../../pipeline/stages/index.ts";

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			return Promise.resolve(results[idx++] || { code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function createMockCtx(): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: {
				fg: (_style: string, text: string) => text,
			},
		},
	} as unknown as ExtensionCommandContext;
}

const mockConfig: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: {
		Backlog: "",
		Architecture: "architect",
		Research: "researcher",
		TestDesign: "test-designer",
		Implementation: "developer",
		Audit: "auditor",
		Done: "",
	},
	maxRejections: 3,
	codeowners: ["user1"],
	defaultBranch: "main",
	remote: "origin",
	worktreeBase: "../worktrees",
	branchPrefix: "worktree-git-issue-",
	ciGatingTimeoutSec: 300,
	bellOnComplete: false,
	enableExperimentalFeatures: false,
	auditScoreThreshold: 0.75,
	vulnGateBlocking: false,
	vulnGateTimeoutSec: 60,
};

function makeProjectFields(statusFieldId: string): ProjectField[] {
	return [
		{
			id: statusFieldId,
			name: "Status",
			type: "single_select",
			options: [
				{ id: "opt_bk", name: "Backlog" },
				{ id: "opt_re", name: "Research" },
				{ id: "opt_ar", name: "Architecture" },
				{ id: "opt_td", name: "TestDesign" },
				{ id: "opt_im", name: "Implementation" },
				{ id: "opt_au", name: "Audit" },
				{ id: "opt_dn", name: "Done" },
			],
		},
	];
}

function wrapJsonOutput(obj: Record<string, unknown>): string {
	return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

describe("calculateNextStatus()", () => {
	it("returns matching status for latest marker in textOnly", () => {
		// Auditor step has markerMap with AUDIT_DECISION: APPROVED → Done
		const result = calculateNextStatus(
			"auditor",
			"some output",
			"Some text\nAUDIT_DECISION: APPROVED\nmore text",
		);
		assert.equal(result.status, "Done");
		assert.equal(
			result.hadExplicitMarker,
			true,
			"explicit marker should set hadExplicitMarker=true",
		);
	});
	it("auditor AUDIT_DECISION: REJECTED → Implementation (pipeline loops back, not stops)", () => {
		// Auditor rejection should send back to Implementation, not stop the pipeline
		const result = calculateNextStatus(
			"auditor",
			"some output",
			"Some text\nAUDIT_DECISION: REJECTED\nmore text",
		);
		assert.equal(result.status, "Implementation");
	});
	it("falls back to textOutput when textOnly has no marker — Architect → TestDesign", () => {
		const result = calculateNextStatus(
			"architect",
			"Some output\nARCHITECTURE_COMPLETE",
			"text only no markers here",
		);
		assert.equal(result.status, "TestDesign");
	});
	it("infers forward status when no marker found", () => {
		const result = calculateNextStatus("developer", "just some output", "just some text");
		// Developer's markerMap has { IMPLEMENTATION_COMPLETE: "Audit" }
		// inferForwardStatus returns "Audit" as the forward status
		assert.equal(result.status, "Audit");
	});
	it("inferForwardStatus sets hadExplicitMarker=false — developer with no markers, success=true", () => {
		const result = calculateNextStatus("developer", "just some output", "just some text", true);
		assert.equal(result.status, "Audit", "forward status should be inferred when agent succeeds");
		assert.equal(
			result.hadExplicitMarker,
			false,
			"inferred status should have hadExplicitMarker=false",
		);
	});
	it("Bug 1: success=false with no markers — hadExplicitMarker=false", () => {
		const result = calculateNextStatus("developer", "", "", false);
		assert.equal(result.status, null);
		assert.equal(result.hadExplicitMarker, false);
	});
	it("unknown agent — hadExplicitMarker=false (status null)", () => {
		const result = calculateNextStatus("unknown-agent", "some output", "some text");
		assert.equal(result.status, null);
		assert.equal(result.hadExplicitMarker, false);
	});
	it("last occurrence wins (overrides earlier markers) — Architect FEEDBACK_RESEARCH", () => {
		// Architect now has FEEDBACK_RESEARCH → Research (feedback loop)
		// Test: last marker wins
		const result = calculateNextStatus(
			"architect",
			"ARCHITECTURE_COMPLETE\nsome text\nFEEDBACK_RESEARCH",
			"ARCHITECTURE_COMPLETE\nsome text\nFEEDBACK_RESEARCH",
		);
		// Last marker is FEEDBACK_RESEARCH → Research
		assert.equal(result.status, "Research");
	});
	it("returns null for unknown agent name", () => {
		const result = calculateNextStatus("unknown-agent", "some output", "some text");
		assert.equal(result.status, null);
		assert.ok(result.stopReason);
	});
	it("Bug 1: success=false does NOT infer forward status — developer with no output returns null", () => {
		// When agent fails (success=false), inferForwardStatus must NOT be called.
		// Without this fix, inferForwardStatus would return "Audit" for the developer step.
		const result = calculateNextStatus("developer", "", "", false);
		assert.equal(result.status, null, "forward status must NOT be inferred when agent fails");
		assert.ok(result.stopReason, "should provide stop reason");
		assert.ok(
			result.stopReason!.toLowerCase().includes("no completion marker"),
			"stopReason should mention missing completion marker",
		);
	});
	it("Bug 1: success=false with explicit success marker — still returns marker status", () => {
		// Even when agent failed, if output contains a completion marker, use it
		const result = calculateNextStatus(
			"developer",
			"IMPLEMENTATION_COMPLETE",
			"IMPLEMENTATION_COMPLETE",
			false,
		);
		assert.equal(result.status, "Audit", "explicit marker should still be honored despite failure");
	});
	it("Bug 1: success=true infers forward status when no marker found (backward compat)", () => {
		// When agent succeeded, backward-compatible inferForwardStatus should still work
		const result = calculateNextStatus("developer", "just some output", "just some text", true);
		assert.equal(result.status, "Audit", "forward status should be inferred when agent succeeds");
	});
	it("Bug 1: success=false for auditor — does not infer Done", () => {
		// Auditor that fails should not get forward-inferred "Done" status
		const result = calculateNextStatus("auditor", "", "", false);
		assert.equal(result.status, null, "forward status must NOT be inferred when auditor fails");
	});
	it("Bug 1: success=false still allows feedback markers (explicit AUDIT_REJECTED)", () => {
		// Even on failure, explicit markers in output should still be matched
		const result = calculateNextStatus("auditor", "AUDIT_REJECTED", "AUDIT_REJECTED", false);
		assert.equal(result.status, "Implementation", "explicit rejection marker should still work");
	});
	it("refusal → refusal stop: status null, stopReason 'Agent refused', hadExplicitMarker=true, refusal attached", () => {
		const agentOutput = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
			refusal: "cannot implement this",
		});
		const result = calculateNextStatus("developer", agentOutput, agentOutput);
		assert.equal(result.status, null, "refusal never maps to a status");
		assert.ok(
			result.stopReason?.includes("Agent refused: cannot implement this"),
			`stopReason, got: ${result.stopReason}`,
		);
		assert.equal(
			result.hadExplicitMarker,
			true,
			"refusal is an explicit agent signal (Bug #711 guard must not double-fire)",
		);
		assert.equal(result.refusal?.refused, true);
		assert.equal(result.refusal?.refusal, "cannot implement this");
	});
	it("refusal beats text markers — forward marker in output still stops, no transition", () => {
		// Researcher output contains the RESEARCH_COMPLETE forward marker AND a
		// structured refusal: the refusal must win (deliberate stop), never the
		// marker fallback (Research → Architecture transition).
		const agentOutput = JSON.stringify({
			agentName: "researcher",
			refusal: "cannot research this",
		});
		const textOnly = "Research complete.\nRESEARCH_COMPLETE";
		const result = calculateNextStatus("researcher", agentOutput, textOnly);
		assert.equal(result.status, null, "refusal must beat the forward text marker");
		assert.ok(
			result.stopReason?.includes("Agent refused"),
			`stopReason, got: ${result.stopReason}`,
		);
		assert.equal(result.refusal?.refusal, "cannot research this");
	});
	it("success=false + refusal → refusal stop, not Bug #711 failed-agent stop (hadExplicitMarker=true)", () => {
		const agentOutput = JSON.stringify({
			agentName: "researcher",
			refusal: "cannot research this",
		});
		const result = calculateNextStatus("researcher", agentOutput, agentOutput, false);
		assert.equal(result.status, null, "refusal → null status, never a transition");
		assert.equal(
			result.hadExplicitMarker,
			true,
			"hadExplicitMarker=true prevents the failed-agent guard from double-firing",
		);
		assert.ok(
			result.stopReason?.includes("Agent refused"),
			`stopReason, got: ${result.stopReason}`,
		);
	});
	it("non-refusal null-status path unchanged — marker fallback → inferForwardStatus still reachable", () => {
		// Regression pin: refusal detection must not shadow the existing
		// fallback chain for output WITHOUT a refusal key.
		const markerResult = calculateNextStatus(
			"architect",
			"Some output\nARCHITECTURE_COMPLETE",
			"text only no markers here",
		);
		assert.equal(markerResult.status, "TestDesign", "marker fallback still works");

		const inferredResult = calculateNextStatus(
			"developer",
			"just some output",
			"just some text",
			true,
		);
		assert.equal(inferredResult.status, "Audit", "inferForwardStatus still works");
		assert.equal(inferredResult.hadExplicitMarker, false);

		const auditorResult = calculateNextStatus(
			"auditor",
			"no markers at all",
			"no markers at all",
			true,
		);
		assert.equal(auditorResult.status, "Done", "auditor ponytail fallback still works");
	});
	it("unparseable REJECTED auditor output → Implementation, NEVER Done (regression #1698: rejection created a PR + closed the issue)", () => {
		// Live incident shape: REJECTED JSON with escaped-\\n commentBody (heading
		// mid-line inside the one-line string value) + findings failing schema
		// validation (severity not in the enum) → structured parse fails. The
		// comment poster (extractStructuredAuditMarkers, pan-text) DID post
		// "## Audit Rejected"; the status parser must reach the same verdict —
		// a rejection must loop back to Implementation, never default to Done
		// via the ponytail fallback (which would create a PR and close the issue
		// on top of the posted rejection comment).
		const raw = [
			`{`,
			`  "agentName": "auditor",`,
			`  "action": "REJECTED",`,
			`  "commentBody": "## Audit Rejected\\n\\n### Findings\\n\\n1. **Correctness & Safety — about.go:54-55**\\n   - Symptom: write errors ignored\\n   - Consequence: partial output reports success\\n   - Remedy: return wrapped error\\n\\n### Audit Score\\nAUDIT_SCORE: 7/10",`,
			`  "summary": "Rejected - issues found",`,
			`  "findings": [{ "severity": "error", "dimension": "code-quality", "symptom": "x", "consequence": "y", "remedy": "z", "location": "about.go" }]`,
			`}`,
		].join("\n");

		const result = calculateNextStatus("auditor", raw, raw, true);
		assert.equal(
			result.status,
			"Implementation",
			"REJECTED must loop back to developer — got: " + result.status,
		);
		assert.equal(result.hadExplicitMarker, true, "rejection is an explicit agent signal");
	});
	it("auditor APPROVED + score meets threshold (5/7 with 0.75) → Done, no gateRejected", () => {
		// 5 passing out of 7 with threshold 0.75 → required = ceil(7*0.75) = 6 → 5 < 6 → fails
		// Use 6/7 passing to meet threshold
		const agentOutput = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "suggestion",
					dimension: "code-quality",
					symptom: "Minor",
					consequence: "Minor",
					remedy: "Fix",
				},
			],
		});
		// 1 suggestion finding only → 7/7 passing → meets 6 required
		const auditContext: AuditGateContext = { researcherSkipped: true, scoreThreshold: 0.75 };
		const result = calculateNextStatus("auditor", agentOutput, "", true, auditContext);
		assert.equal(result.status, "Done");
		assert.equal(result.gateRejected, undefined);
	});
	it("auditor APPROVED + score below threshold (5/7 with 0.75) → Implementation, gateRejected", () => {
		// 5 passing out of 7 with threshold 0.75 → required = ceil(7*0.75) = 6 → 5 < 6 → fails
		const agentOutput = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "critical",
					dimension: "architecture-compliance",
					symptom: "Bad arch",
					consequence: "Hard",
					remedy: "Fix",
				},
				{
					severity: "warning",
					dimension: "ticket-fulfillment",
					symptom: "Missing scope",
					consequence: "Incomplete",
					remedy: "Add",
				},
				{
					severity: "critical",
					dimension: "test-quality",
					symptom: "No tests",
					consequence: "Bugs",
					remedy: "Add",
				},
			],
		});
		// 3 critical/warning findings → 3 dimensions failed → 4/7 passing → required=6 → FAILS
		const auditContext: AuditGateContext = { researcherSkipped: true, scoreThreshold: 0.75 };
		const result = calculateNextStatus("auditor", agentOutput, "", true, auditContext);
		assert.equal(result.status, "Implementation");
		assert.ok(result.gateRejected, "gateRejected should be populated");
		assert.equal(result.gateRejected!.score.passing, 4);
		assert.equal(result.gateRejected!.total, 7);
		assert.equal(result.gateRejected!.required, 6);
	});
	it("auditor REJECTED → Implementation unchanged (no gate logic)", () => {
		const agentOutput = JSON.stringify({
			action: "REJECTED",
			agentName: "auditor",
			findings: [
				{
					severity: "critical",
					dimension: "architecture-compliance",
					symptom: "Bad arch",
					consequence: "Hard",
					remedy: "Fix",
				},
			],
		});
		const auditContext: AuditGateContext = { researcherSkipped: false, scoreThreshold: 0.75 };
		const result = calculateNextStatus("auditor", agentOutput, "", true, auditContext);
		assert.equal(result.status, "Implementation");
		assert.equal(result.gateRejected, undefined, "gateRejected should not be set for REJECTED");
	});
	it("auditor with COMPLETE (no findings, no commentBody) defaults to Done", () => {
		const agentOutput = JSON.stringify({
			action: "COMPLETE",
			agentName: "auditor",
		});
		const result = calculateNextStatus("auditor", agentOutput, "SOME_OTHER_MARKER");
		// Structured JSON parsing finds action: COMPLETE with no findings and no
		// commentBody. The resolveNextStatusFromAgentOutput function has a final
		// fallback: when hadBareComplete is true, default to APPROVED/Done to
		// prevent pipeline deadlock (auditor used generic template instead of
		// the auditor-specific APPROVED/REJECTED template).
		assert.equal(result.status, "Done");
		assert.equal(result.hadExplicitMarker, true);
	});
	it("developer → audit gate NOT evaluated even with auditContext", () => {
		const agentOutput = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
		});
		const auditContext: AuditGateContext = { researcherSkipped: false, scoreThreshold: 0.75 };
		const result = calculateNextStatus("developer", agentOutput, "", true, auditContext);
		// Gate logic only triggers for agentName === "auditor"
		// Developer with no markers and success=true → inferForwardStatus → Audit
		assert.equal(result.status, "Audit");
		assert.equal(result.gateRejected, undefined);
	});
	it("architect → audit gate NOT evaluated", () => {
		const agentOutput = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
		});
		const auditContext: AuditGateContext = { researcherSkipped: false, scoreThreshold: 0.75 };
		const result = calculateNextStatus(
			"architect",
			agentOutput,
			"ARCHITECTURE_COMPLETE",
			true,
			auditContext,
		);
		assert.equal(result.status, "TestDesign");
		assert.equal(result.gateRejected, undefined);
	});
});
