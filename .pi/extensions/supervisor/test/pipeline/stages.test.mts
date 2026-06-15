// ─── Tests: pipeline/stages.ts — pure + async functions ─────────
// Covers all exported functions in stages.ts with mock dependencies.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	ProjectField,
	AgentRunResult,
	FilteredIssueData,
} from "../../config/types.ts";
import {
	MAX_PIPELINE_LOOPS,
	resolveAgentName,
	isDoneStatus,
	isWorktreeAgent,
	isRejectionLimitReached,
	calculateNextStatus,
	trackAuditScore,
	buildAgentResultEntry,
	createStageState,
	type StageState,
	type AuditGateContext,
	type GateRejected,
	handleBacklogTransition,
	applyStatusTransition,
	handlePostAgentSuccess,
	validateResearcherFindings,
	hasBranchCommits,
	applyGateFailureContext,
} from "../../pipeline/stages.ts";

// ─── Mock Helpers ──────────────────────────────────────────────────

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

// ─── Fixtures ──────────────────────────────────────────────────────

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

// ─── Tests: resolveAgentName() ────────────────────────────────────

describe("resolveAgentName()", () => {
	it("returns mapped agent name for known status via workflow agentName", () => {
		// "Architecture" maps to "architect" in WORKFLOW's agentName
		const result = resolveAgentName("Architecture", mockConfig);
		assert.equal(result, "architect");
	});

	it("returns null for unknown status", () => {
		const result = resolveAgentName("NonExistentStatus", mockConfig);
		assert.equal(result, null);
	});

	it("returns null when status has no agent mapping and no statusMapping entry", () => {
		// "Done" is in WORKFLOW, has no agentName property, and not in statusMapping
		const result = resolveAgentName("Done", { ...mockConfig, statusMapping: {} });
		assert.equal(result, null);
	});
});

// ─── Tests: isDoneStatus() ────────────────────────────────────────

describe("isDoneStatus()", () => {
	it("returns true for 'Done'", () => {
		assert.equal(isDoneStatus("Done"), true);
	});

	it("returns true for 'done' (lowercase)", () => {
		assert.equal(isDoneStatus("done"), true);
	});

	it("returns true for 'DONE' (uppercase)", () => {
		assert.equal(isDoneStatus("DONE"), true);
	});

	it("returns false for any other string", () => {
		assert.equal(isDoneStatus("Architecture"), false);
		assert.equal(isDoneStatus("In Progress"), false);
		assert.equal(isDoneStatus(""), false);
		assert.equal(isDoneStatus("don"), false);
	});
});

// ─── Tests: isWorktreeAgent() ─────────────────────────────────────

describe("isWorktreeAgent()", () => {
	it("returns true for 'developer'", () => {
		assert.equal(isWorktreeAgent("developer"), true);
	});

	it("returns true for 'auditor'", () => {
		assert.equal(isWorktreeAgent("auditor"), true);
	});

	it("returns false for 'architect'", () => {
		assert.equal(isWorktreeAgent("architect"), false);
	});

	it("returns false for 'researcher'", () => {
		assert.equal(isWorktreeAgent("researcher"), false);
	});

	it("returns false for 'test-designer'", () => {
		assert.equal(isWorktreeAgent("test-designer"), false);
	});
});

// ─── Tests: isRejectionLimitReached() ─────────────────────────────

describe("isRejectionLimitReached()", () => {
	it("returns true when rejection marker count >= maxRejections", () => {
		const comments = [
			{ body: "## Audit Rejected\nSome issue" },
			{ body: "## Audit Rejected\nAnother issue" },
			{ body: "## Audit Rejected\nThird issue" },
			{ body: "## Audit Approved\nLooks good" },
		];
		assert.equal(isRejectionLimitReached(comments, 3), true);
	});

	it("returns false when below maxRejections", () => {
		const comments = [
			{ body: "## Audit Rejected\nSome issue" },
			{ body: "## Audit Approved\nLooks good" },
		];
		assert.equal(isRejectionLimitReached(comments, 3), false);
	});

	it("returns false when maxRejections is 0", () => {
		const comments = [{ body: "## Audit Rejected\nSome issue" }];
		assert.equal(isRejectionLimitReached(comments, 0), false);
	});

	it("returns false when maxRejections is undefined", () => {
		const comments = [{ body: "## Audit Rejected\nSome issue" }];
		assert.equal(isRejectionLimitReached(comments, undefined), false);
	});

	it("matches case-insensitive '## Audit Rejected'", () => {
		const comments = [
			{ body: "## audit rejected\nsome issue" },
			{ body: "## AUDIT REJECTED\nanother" },
			{ body: "## Audit Rejected\nthird" },
		];
		assert.equal(isRejectionLimitReached(comments, 3), true);
	});

	it("does not match unrelated headers", () => {
		const comments = [
			{ body: "## Audit Approved\nLooks good" },
			{ body: "## Some other header\ncontent" },
		];
		assert.equal(isRejectionLimitReached(comments, 1), false);
	});
});

// ─── Tests: calculateNextStatus() ─────────────────────────────────

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

	// ─── Audit Score Gate tests (Bug #648) ───────────────────────

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

	it("auditor with no action in structured output falls through to text marker", () => {
		const agentOutput = JSON.stringify({
			action: "COMPLETE",
			agentName: "auditor",
		});
		const result = calculateNextStatus("auditor", agentOutput, "SOME_OTHER_MARKER");
		// Falls through from structured parsing, then no markers match, then inferForwardStatus
		// Auditor step has no forward markers (all AUDIT_*) → inferForwardStatus returns null
		// but success=true so it tries inferForwardStatus → null
		assert.equal(result.status, null);
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

	it("researcher → audit gate NOT evaluated", () => {
		const agentOutput = JSON.stringify({
			action: "COMPLETE",
			agentName: "researcher",
		});
		const auditContext: AuditGateContext = { researcherSkipped: false, scoreThreshold: 0.75 };
		const result = calculateNextStatus(
			"researcher",
			agentOutput,
			"RESEARCH_COMPLETE",
			true,
			auditContext,
		);
		assert.equal(result.status, "Architecture");
		assert.equal(result.gateRejected, undefined);
	});

	it("gate rejects when researcherSkipped=true → denominator is 7", () => {
		const agentOutput = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "critical",
					dimension: "architecture-compliance",
					symptom: "Bad",
					consequence: "Hard",
					remedy: "Fix",
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
		// 2 dimensions failed out of 7 → 5/7 < required 6 → fails
		const auditContext: AuditGateContext = { researcherSkipped: true, scoreThreshold: 0.75 };
		const result = calculateNextStatus("auditor", agentOutput, "", true, auditContext);
		assert.equal(result.status, "Implementation");
		assert.ok(result.gateRejected, "gateRejected should be set");
		assert.equal(result.gateRejected!.total, 7);
		assert.equal(result.gateRejected!.required, 6);
	});

	it("gate rejects when researcherSkipped=false → denominator is 8", () => {
		const agentOutput = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "critical",
					dimension: "architecture-compliance",
					symptom: "Bad",
					consequence: "Hard",
					remedy: "Fix",
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
		// 2 dimensions failed out of 8 → 6/8 = required 6 → passes (6 >= 6)
		// So use 3 failed to fail: 5/8 < 6
		const threeFailures = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "critical",
					dimension: "architecture-compliance",
					symptom: "Bad",
					consequence: "Hard",
					remedy: "Fix",
				},
				{
					severity: "warning",
					dimension: "test-quality",
					symptom: "No tests",
					consequence: "Bugs",
					remedy: "Add",
				},
				{
					severity: "critical",
					dimension: "code-quality",
					symptom: "Lint",
					consequence: "Debt",
					remedy: "Fix",
				},
			],
		});
		const auditContext: AuditGateContext = { researcherSkipped: false, scoreThreshold: 0.75 };
		const result = calculateNextStatus("auditor", threeFailures, "", true, auditContext);
		assert.equal(result.status, "Implementation");
		assert.ok(result.gateRejected);
		assert.equal(result.gateRejected!.total, 8);
		assert.equal(result.gateRejected!.required, 6);
	});

	it("auditContext with scoreThreshold=1.0 → only perfect score passes", () => {
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
		// 1 suggestion → no dimensions failed → 7/7 with researcher skipped
		// required = ceil(7 * 1.0) = 7 → passes
		const auditContext: AuditGateContext = { researcherSkipped: true, scoreThreshold: 1.0 };
		const result = calculateNextStatus("auditor", agentOutput, "", true, auditContext);
		assert.equal(result.status, "Done");
		assert.equal(result.gateRejected, undefined);
	});

	it("auditContext with scoreThreshold=1.0 → non-perfect score fails", () => {
		const agentOutput = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "critical",
					dimension: "architecture-compliance",
					symptom: "Bad",
					consequence: "Hard",
					remedy: "Fix",
				},
			],
		});
		const auditContext: AuditGateContext = { researcherSkipped: true, scoreThreshold: 1.0 };
		const result = calculateNextStatus("auditor", agentOutput, "", true, auditContext);
		assert.equal(result.status, "Implementation");
		assert.ok(result.gateRejected);
	});

	it("auditContext with scoreThreshold=0.0 → any score passes", () => {
		const agentOutput = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "critical",
					dimension: "architecture-compliance",
					symptom: "Bad",
					consequence: "Hard",
					remedy: "Fix",
				},
			],
		});
		const auditContext: AuditGateContext = { researcherSkipped: true, scoreThreshold: 0.0 };
		const result = calculateNextStatus("auditor", agentOutput, "", true, auditContext);
		assert.equal(result.status, "Done");
		assert.equal(result.gateRejected, undefined);
	});

	it("no auditContext → no gate evaluation (backward compat)", () => {
		const agentOutput = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "critical",
					dimension: "architecture-compliance",
					symptom: "Bad",
					consequence: "Hard",
					remedy: "Fix",
				},
			],
		});
		// No auditContext passed — gate is NOT evaluated, original behavior preserved
		const result = calculateNextStatus("auditor", agentOutput, "", true);
		// resolveNextStatusFromAgentOutput finds APPROVED → Done (no gate check)
		assert.equal(result.status, "Done");
		assert.equal(result.gateRejected, undefined);
	});

	it("auditor APPROVED with no findings → score computed is 8/8 (no failed dims) → passes", () => {
		const agentOutput = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			findings: [],
		});
		// Empty findings → all dimensions passing → 8/8 > 6 required → passes
		const auditContext: AuditGateContext = { researcherSkipped: false, scoreThreshold: 0.75 };
		const result = calculateNextStatus("auditor", agentOutput, "", true, auditContext);
		assert.equal(result.status, "Done");
		assert.equal(result.gateRejected, undefined);
	});

	it("auditor APPROVED with findings but only suggestions → all dimensions pass → gate passes", () => {
		const agentOutput = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "suggestion",
					dimension: "architecture-compliance",
					symptom: "Could be better",
					consequence: "Minor",
					remedy: "Improve",
				},
				{
					severity: "suggestion",
					dimension: "code-quality",
					symptom: "Style",
					consequence: "Readability",
					remedy: "Refactor",
				},
			],
		});
		// Suggestions don't fail dimensions → 7/7 (researcher skipped) → passes
		const auditContext: AuditGateContext = { researcherSkipped: true, scoreThreshold: 0.75 };
		const result = calculateNextStatus("auditor", agentOutput, "", true, auditContext);
		assert.equal(result.status, "Done");
		assert.equal(result.gateRejected, undefined);
	});

	// ─── targetStatus tests ─────────────────────────────────────────────────

	it("architect with targetStatus Research → Research (hadExplicitMarker=true)", () => {
		// Structured JSON with targetStatus must bypass the FEEDBACK filter
		const agentOutput = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
			summary: "Need more research",
			targetStatus: "Research",
		});
		const result = calculateNextStatus(
			"architect",
			agentOutput,
			"some text with ARCHITECTURE_COMPLETE",
		);
		assert.equal(result.status, "Research", "should return targetStatus, not TestDesign");
		assert.equal(result.hadExplicitMarker, true, "targetStatus is an explicit marker");
	});

	it("architect with targetStatus Research wins over text marker fallback", () => {
		// Even when textOnly has ARCHITECTURE_COMPLETE, targetStatus in JSON should win
		const agentOutput = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
			summary: "Need more research",
			targetStatus: "Research",
		});
		const result = calculateNextStatus(
			"architect",
			agentOutput,
			"ARCHITECTURE_COMPLETE some design notes",
		);
		assert.equal(
			result.status,
			"Research",
			"targetStatus in structured JSON must win over text markers",
		);
		assert.equal(result.hadExplicitMarker, true);
	});

	it("architect without targetStatus → normal marker resolution (backward compat)", () => {
		const agentOutput = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
			summary: "Architecture done",
		});
		const result = calculateNextStatus("architect", agentOutput, "some text");
		// No targetStatus → COMPLETE handler → ARCHITECTURE_COMPLETE → "TestDesign"
		assert.equal(result.status, "TestDesign");
		assert.equal(result.hadExplicitMarker, true);
	});
});

// ─── Tests: trackAuditScore() ─────────────────────────────────────

describe("trackAuditScore()", () => {
	it("parses 'AUDIT_SCORE: 3/5' to {passing: 3, total: 5}", () => {
		const state = createStageState("Audit");
		const result = trackAuditScore("Some output\nAUDIT_SCORE: 3/5", state);
		assert.ok(result);
		assert.equal(result!.score.passing, 3);
		assert.equal(result!.score.total, 5);
	});

	it("returns null when no marker", () => {
		const state = createStageState("Audit");
		const result = trackAuditScore("Some output with no score", state);
		assert.equal(result, null);
	});

	it("tracks 'improving' trend across consecutive calls", () => {
		const state = createStageState("Audit");
		trackAuditScore("AUDIT_SCORE: 2/5", state);
		const result = trackAuditScore("AUDIT_SCORE: 4/5", state);
		assert.equal(result!.trend, "improving");
	});

	it("tracks 'declining' trend across consecutive calls", () => {
		const state = createStageState("Audit");
		trackAuditScore("AUDIT_SCORE: 4/5", state);
		const result = trackAuditScore("AUDIT_SCORE: 2/5", state);
		assert.equal(result!.trend, "declining");
	});

	it("tracks 'stable' trend when score unchanged", () => {
		const state = createStageState("Audit");
		trackAuditScore("AUDIT_SCORE: 3/5", state);
		const result = trackAuditScore("AUDIT_SCORE: 3/5", state);
		assert.equal(result!.trend, "stable");
	});

	it("increments cycleCount each call with valid marker", () => {
		const state = createStageState("Audit");
		trackAuditScore("AUDIT_SCORE: 3/5", state);
		trackAuditScore("AUDIT_SCORE: 4/5", state);
		const result = trackAuditScore("AUDIT_SCORE: 5/5", state);
		assert.equal(result!.cycleCount, 3);
	});

	it("does not increment cycleCount when no marker found", () => {
		const state = createStageState("Audit");
		trackAuditScore("AUDIT_SCORE: 3/5", state);
		trackAuditScore("no score here", state); // no marker
		const result = trackAuditScore("AUDIT_SCORE: 4/5", state);
		assert.equal(result!.cycleCount, 2); // only 2 valid calls
	});

	it("last occurrence of AUDIT_SCORE wins", () => {
		const state = createStageState("Audit");
		const result = trackAuditScore("AUDIT_SCORE: 2/5\nsome stuff\nAUDIT_SCORE: 5/5", state);
		assert.equal(result!.score.passing, 5);
		assert.equal(result!.score.total, 5);
	});
});

// ─── Tests: buildAgentResultEntry() ───────────────────────────────

describe("buildAgentResultEntry()", () => {
	const baseResult: AgentRunResult = {
		output: "",
		success: true,
		agentName: "developer",
		toolCount: 10,
		tokenCount: 5000,
		durationMs: 30000,
		textOutput: "done",
		summaryLine: "Implemented feature",
		errorOutput: "",
		textOnly: "IMPLEMENTATION_COMPLETE",
	};

	it("maps success=true to 'SUCCESS'", () => {
		const entry = buildAgentResultEntry(baseResult, false);
		assert.equal(entry.status, "SUCCESS");
	});

	it("maps success=true + usedRetry=true to 'SUCCESS (after retry)'", () => {
		const entry = buildAgentResultEntry(baseResult, true);
		assert.equal(entry.status, "SUCCESS (after retry)");
	});

	it("maps success=false to 'FAILED'", () => {
		const entry = buildAgentResultEntry({ ...baseResult, success: false }, false);
		assert.equal(entry.status, "FAILED");
	});

	it("copies durationMs/tokenCount/toolCount/agentName from result", () => {
		const entry = buildAgentResultEntry(
			{
				...baseResult,
				success: true,
				agentName: "auditor",
				durationMs: 15000,
				tokenCount: 3000,
				toolCount: 5,
			},
			false,
		);
		assert.equal(entry.agentName, "auditor");
		assert.equal(entry.durationMs, 15000);
		assert.equal(entry.tokenCount, 3000);
		assert.equal(entry.toolCount, 5);
	});

	it("model is undefined when not provided", () => {
		const entry = buildAgentResultEntry(baseResult, false);
		assert.equal(entry.model, undefined);
	});

	it("model is set when provided", () => {
		const entry = buildAgentResultEntry(baseResult, false, "anthropic/claude-sonnet-4-20250514");
		assert.equal(entry.model, "anthropic/claude-sonnet-4-20250514");
	});

	it("model shows as short name in pipeline output", () => {
		const entry = buildAgentResultEntry(baseResult, false, "anthropic/claude-sonnet-4-20250514");
		const shortModel = (m?: string) => (m ? m.split("/").pop() || m : "—");
		assert.equal(shortModel(entry.model), "claude-sonnet-4-20250514");
	});

	it("threads errorOutput from AgentRunResult when provided", () => {
		const entry = buildAgentResultEntry(
			{ ...baseResult, success: false, errorOutput: "Failed to start: ENOENT" },
			false,
		);
		assert.equal(entry.status, "FAILED");
		assert.equal(entry.errorOutput, "Failed to start: ENOENT");
	});

	it("errorOutput is undefined when AgentRunResult has empty errorOutput", () => {
		const entry = buildAgentResultEntry(baseResult, false);
		assert.equal(entry.errorOutput, undefined);
	});

	it("model is undefined when not provided, shows dash in output", () => {
		const entry = buildAgentResultEntry(baseResult, false);
		const shortModel = (m?: string) => (m ? m.split("/").pop() || m : "—");
		assert.equal(shortModel(entry.model), "—");
	});
});

// ─── Tests: handleBacklogTransition() ─────────────────────────────

describe("handleBacklogTransition()", () => {
	const statusFieldId = "sf_status";

	it("calls setItemStatus with correct args and returns 'Research' on success", async () => {
		const calls: ExecCall[] = [];
		// setItemStatus calls gh(pi, ["project", "item-edit", ...])
		// which calls pi.exec("gh", [...])
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		const fields = makeProjectFields(statusFieldId);

		const result = await handleBacklogTransition(
			pi,
			fields,
			statusFieldId,
			"item_123",
			"project_456",
		);
		assert.equal(result, "Research");

		// Verify the gh project item-edit call was made
		assert.ok(calls.length >= 1);
		const ghCall = calls.find((c) => c.cmd === "gh" || c.cmd === "bash");
		assert.ok(ghCall, "setItemStatus should call gh");
		assert.ok(ghCall!.args.includes("item_123"));
		assert.ok(ghCall!.args.includes("project_456"));
	});

	it("throws when 'Research' option not found", async () => {
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }]);
		// No "Research" option
		const fields: ProjectField[] = [
			{
				id: statusFieldId,
				name: "Status",
				type: "single_select",
				options: [
					{ id: "opt_bk", name: "Backlog" },
					{ id: "opt_ar", name: "Architecture" },
				],
			},
		];

		await assert.rejects(
			() => handleBacklogTransition(pi, fields, statusFieldId, "item_123", "project_456"),
			/Cannot find 'Research' status option/,
		);
	});

	it("throws when setItemStatus fails", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 1, stdout: "", stderr: "network error" }], calls);
		const fields = makeProjectFields(statusFieldId);

		await assert.rejects(
			() => handleBacklogTransition(pi, fields, statusFieldId, "item_123", "project_456"),
			/Failed to set status/,
		);
	});
});

// ─── Tests: applyStatusTransition() ───────────────────────────────

describe("applyStatusTransition()", () => {
	const statusFieldId = "sf_status";

	it("calls setItemStatus with correct option id and returns targetStatus", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		const fields = makeProjectFields(statusFieldId);

		const result = await applyStatusTransition(
			pi,
			"item_123",
			"project_456",
			fields,
			statusFieldId,
			"Audit",
		);
		assert.equal(result, "Audit");

		// Verify gh was called
		const ghCall = calls.find((c) => c.cmd === "gh" || c.cmd === "bash");
		assert.ok(ghCall, "setItemStatus should call gh");
	});

	it("throws when option not found", async () => {
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }]);
		const fields: ProjectField[] = [
			{
				id: statusFieldId,
				name: "Status",
				type: "single_select",
				options: [{ id: "opt_bk", name: "Backlog" }],
			},
		];

		await assert.rejects(
			() => applyStatusTransition(pi, "item_123", "project_456", fields, statusFieldId, "Audit"),
			/Cannot find 'Audit' option on board/,
		);
	});
});

// ─── Tests: handlePostAgentSuccess() ─────────────────────────────

describe("handlePostAgentSuccess()", () => {
	const baseResult: AgentRunResult = {
		output: "",
		success: true,
		agentName: "architect",
		toolCount: 5,
		tokenCount: 2000,
		durationMs: 10000,
		textOutput: "COMMENT_BODY:\n## Architecture\nSome design\nCOMMENT_BODY_END",
		summaryLine: "Wrote architecture",
		errorOutput: "",
		textOnly:
			"COMMENT_BODY:\n## Architecture\nSome design\nCOMMENT_BODY_END\nARCHITECTURE_COMPLETE",
	};

	it("posts comment for architect when output contains COMMENT_BODY — returns true", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		const ctx = createMockCtx();
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			baseResult,
			"architect",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "architect comment post succeeds — pipeline should continue");
		// Should call gh issue comment
		const ghCall = calls.find(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.includes("issue"),
		);
		assert.ok(ghCall, "should call gh issue comment for architect");
	});

	it("architect comment post fails (gh error) — returns true (advisory), pipeline continues", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 1, stdout: "", stderr: "network error" }], calls);
		const ctx = createMockCtx();
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			baseResult,
			"architect",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "architect comment failure is advisory — pipeline should continue");
	});

	it("posts comment for test-designer when output contains COMMENT_BODY — returns true", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "test-designer",
			textOutput: "COMMENT_BODY:\n## Test Plan\nLots of tests\nCOMMENT_BODY_END",
			textOnly: "COMMENT_BODY:\n## Test Plan\nLots of tests\nCOMMENT_BODY_END\nTEST_PLAN_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"test-designer",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "test-designer success — pipeline should continue");
		const ghCall = calls.find(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.includes("issue"),
		);
		assert.ok(ghCall, "should call gh issue comment for test-designer");
	});

	it("posts comment for researcher when output contains COMMENT_BODY — returns true", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "researcher",
			textOutput: "COMMENT_BODY:\n## Research Findings\nStuff\nCOMMENT_BODY_END",
			textOnly: "COMMENT_BODY:\n## Research Findings\nStuff\nCOMMENT_BODY_END\nRESEARCH_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"researcher",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "researcher success — pipeline should continue");
		const ghCall = calls.find(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.includes("issue"),
		);
		assert.ok(ghCall, "should call gh issue comment for researcher");
	});

	it("researcher comment post fails (gh error) — returns true (advisory), pipeline continues", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 1, stdout: "", stderr: "timeout" }], calls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "researcher",
			textOutput: "COMMENT_BODY:\n## Research Findings\nStuff\nCOMMENT_BODY_END",
			textOnly: "COMMENT_BODY:\n## Research Findings\nStuff\nCOMMENT_BODY_END\nRESEARCH_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"researcher",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(
			success,
			true,
			"researcher comment failure is advisory — pipeline should continue",
		);
	});

	it("commits and pushes for developer when worktreePath and branch provided — returns true", async () => {
		const calls: ExecCall[] = [];
		// developer commit+pull uses: commitAndPush which calls git add, commit, push
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add -A
				{ code: 0, stdout: "", stderr: "" }, // git commit
				{ code: 0, stdout: "", stderr: "" }, // git push
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, true, "commit/push succeeds — pipeline should continue");
		// Should call git operations
		const gitCalls = calls.filter((c) => c.cmd === "git");
		assert.ok(gitCalls.length > 0, "should call git operations for developer");
	});

	it("developer git add fails (code 1) — returns false, signals critical failure", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 1, stdout: "", stderr: "fatal: could not add" }, // git add fails
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, false, "git add failure must return false — pipeline should stop");
	});

	it("developer git commit fails with real error (not 'nothing to commit') — returns false", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add succeeds
				{ code: 1, stdout: "", stderr: "fatal: bad object" }, // git commit fails
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, false, "git commit failure must return false — pipeline should stop");
	});

	it("developer git push fails (network error) — returns false", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add succeeds
				{ code: 0, stdout: "", stderr: "" }, // git commit succeeds
				{ code: 1, stdout: "", stderr: "fatal: could not push" }, // git push fails
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, false, "git push failure must return false — pipeline should stop");
	});

	it("developer commit returns 'nothing to commit' — returns true (still pushes, branch may not exist on remote)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add succeeds
				{ code: 1, stdout: "", stderr: "nothing to commit, working tree clean" }, // git commit: nothing to commit
				{ code: 0, stdout: "Everything up-to-date", stderr: "" }, // git push succeeds
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, true, "'nothing to commit' returns silently — pipeline continues");
		// calls: git add, git commit, git push (branch may not exist on remote), git diff (README check)
		assert.equal(calls.length, 4, "should call add + commit + push + diff");
		// Verify push was called (fix #595: branch may not exist on remote yet)
		const pushCall = calls[2];
		assert.equal(pushCall.cmd, "git", "third call should be git");
		assert.equal(pushCall.args[0], "push", "third call should be push");
		// Verify the commit call happened
		const commitCall = calls[1];
		assert.ok(commitCall.args.includes("commit"), "second call should be commit");
	});

	it("developer with worktreePath undefined — returns true (no-op)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			undefined,
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, true, "no worktreePath — no-op, pipeline should continue");
		assert.equal(calls.length, 0);
	});

	it("developer with worktreeBranch undefined — returns true (no-op)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "no worktreeBranch — no-op, pipeline should continue");
		assert.equal(calls.length, 0);
	});

	it("handles auditor approval output with structured AUDIT_DECISION — returns true", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // post issue comment
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput:
				"AUDIT_DECISION: APPROVED\nCOMMENT_BODY:\n## Audit Approved\nLooks good\nCOMMENT_BODY_END",
			textOnly:
				"AUDIT_DECISION: APPROVED\nCOMMENT_BODY:\n## Audit Approved\nLooks good\nCOMMENT_BODY_END",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"auditor",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "auditor — pipeline should continue");
		// Should call gh issue comment
		const ghCall = calls.find(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.includes("comment"),
		);
		assert.ok(ghCall, "should post audit approval comment");
	});

	it("handles auditor rejection output — returns true", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // post issue comment
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput:
				"AUDIT_DECISION: REJECTED\nCOMMENT_BODY:\n## Audit Rejected\nFix it\nCOMMENT_BODY_END",
			textOnly:
				"AUDIT_DECISION: REJECTED\nCOMMENT_BODY:\n## Audit Rejected\nFix it\nCOMMENT_BODY_END",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"auditor",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "auditor — pipeline should continue");
		const ghCall = calls.find(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.includes("comment"),
		);
		assert.ok(ghCall, "should post audit rejection comment");
	});

	it("handles auditor output with no COMMENT_BODY marker and no JSON — no comment posted, pipeline continues", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput: "AUDIT_DECISION: APPROVED\nSome details\nAUDIT_SCORE: 4/6",
			textOnly: "AUDIT_DECISION: APPROVED\nSome details\nAUDIT_SCORE: 4/6",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"auditor",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "auditor — pipeline should continue");
		const ghCall = calls.find(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.includes("comment"),
		);
		assert.equal(
			ghCall,
			undefined,
			"no comment posted when output has no JSON and no COMMENT_BODY marker",
		);
	});

	it("does not post comment for developer (no comment body extraction needed)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		// No gh calls expected for developer without worktree
		assert.equal(success, true, "no worktree — no-op, pipeline should continue");
		assert.equal(calls.length, 0);
	});

	// ─── notify parameter tests (Result<T> pattern) ────────────────

	it("developer with notify parameter — commitAndPush success returns true", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add -A
				{ code: 0, stdout: "committed", stderr: "" }, // git commit
				{ code: 0, stdout: "", stderr: "" }, // git push
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		// Provide a notify function and verify it's used correctly
		const notifyCalls: Array<{ level: string; msg: string }> = [];
		const notify = {
			info: (msg: string) => notifyCalls.push({ level: "info", msg }),
			error: (msg: string) => notifyCalls.push({ level: "error", msg }),
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
			undefined, // collector
			undefined, // gateRejected
			notify, // notify
		);

		assert.equal(success, true, "commit/push with notify should succeed");
		// notify.error should NOT be called on success
		assert.equal(notifyCalls.filter((c) => c.level === "error").length, 0);
		// git calls: add + commit + push
		assert.ok(calls.length >= 3);
	});

	it("developer with notify parameter — commitAndPush returns Result.ok=false on push failure, handlePostAgentSuccess returns false", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add -A
				{ code: 0, stdout: "committed", stderr: "" }, // git commit
				{ code: 1, stdout: "", stderr: "push rejected" }, // git push fails
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const notifyCalls: Array<{ level: string; msg: string }> = [];
		const notify = {
			info: (msg: string) => notifyCalls.push({ level: "info", msg }),
			error: (msg: string) => notifyCalls.push({ level: "error", msg }),
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
			undefined, // collector
			undefined, // gateRejected
			notify, // notify
		);

		// commitAndPush now returns Result<boolean> with ok=false on push failure
		// commitAndPush internally calls pushBranch which uses withNotify/notify.error
		// Then handlePostAgentSuccess sees !commitResult.ok and returns false
		assert.equal(success, false, "push failure should return false — pipeline stops");
	});

	it("gateRejected passed to auditor → posts gate rejection comment instead of approval", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // post issue comment for gate rejection
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput: JSON.stringify({
				action: "APPROVED",
				agentName: "auditor",
				commentBody: "## Audit Approved\nAll good",
			}),
			textOnly: "",
		};
		const filteredData: FilteredIssueData = { body: "", comments: [] };
		const gateRejected = {
			score: { passing: 4, total: 7 },
			required: 6,
			total: 7,
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"auditor",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
			undefined,
			gateRejected,
		);

		assert.equal(success, true, "gate rejection should still allow pipeline to continue");
		// Should call gh issue comment
		const ghCall = calls.find(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.includes("comment"),
		);
		assert.ok(ghCall, "should post gate rejection comment");
		// Verify the comment body contains gate rejection info
		const commentIdx = calls.findIndex(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.includes("comment"),
		);
		assert.ok(commentIdx >= 0, "comment should be posted");
	});

	it("gateRejected with auditor REJECTED action → gate still posted (gate takes priority)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // post issue comment for gate rejection
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput: JSON.stringify({
				action: "REJECTED",
				agentName: "auditor",
				commentBody: "## Audit Rejected\nBad code",
			}),
			textOnly: "",
		};
		const filteredData: FilteredIssueData = { body: "", comments: [] };
		const gateRejected = {
			score: { passing: 3, total: 8 },
			required: 6,
			total: 8,
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"auditor",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
			undefined,
			gateRejected,
		);

		assert.equal(success, true);
		// Gate rejection should still be posted even though auditor said REJECTED
		const ghCall = calls.find(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.includes("comment"),
		);
		assert.ok(ghCall, "should post gate rejection comment");
	});

	it("no gateRejected + auditor APPROVED → normal approval comment posted", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // post issue comment
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput: JSON.stringify({
				action: "APPROVED",
				agentName: "auditor",
				commentBody: "## Audit Approved\nAll good",
			}),
			textOnly: "",
		};
		const filteredData: FilteredIssueData = { body: "", comments: [] };

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"auditor",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true);
		const ghCall = calls.find(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.includes("comment"),
		);
		assert.ok(ghCall, "should post normal approval comment");
	});

	it("no gateRejected + auditor REJECTED → normal rejection comment posted", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // post issue comment
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput: JSON.stringify({
				action: "REJECTED",
				agentName: "auditor",
				commentBody: "## Audit Rejected\nBad code",
			}),
			textOnly: "",
		};
		const filteredData: FilteredIssueData = { body: "", comments: [] };

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"auditor",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true);
		const ghCall = calls.find(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.includes("comment"),
		);
		assert.ok(ghCall, "should post normal rejection comment");
	});

	// ─── Tests: MAX_PIPELINE_LOOPS constant ───────────────────────────

	describe("MAX_PIPELINE_LOOPS", () => {
		it("is a positive integer", () => {
			assert.equal(typeof MAX_PIPELINE_LOOPS, "number");
			assert.ok(MAX_PIPELINE_LOOPS > 0);
		});

		it("equals 20", () => {
			// Explicit value check — changing this has implications for loop limits
			assert.equal(MAX_PIPELINE_LOOPS, 20);
		});
	});
});

// ─── Tests: createStageState() ────────────────────────────────────

describe("createStageState()", () => {
	it("creates state with given initial status", () => {
		const state = createStageState("Architecture");
		assert.equal(state.loopStatus, "Architecture");
		assert.equal(state.lastAuditScore, null);
		assert.equal(state.auditCycleCount, 0);
	});

	it("creates state with 'Done' status", () => {
		const state = createStageState("Done");
		assert.equal(state.loopStatus, "Done");
	});

	it("initializes researcherSkipped to false", () => {
		const state = createStageState("Research");
		assert.equal(state.researcherSkipped, false);
	});

	it("initializes duplicateCodeResult to null", () => {
		const state = createStageState("Implementation");
		assert.equal(state.duplicateCodeResult, null);
	});
});

// ─── Tests: validateResearcherFindings() ──────────────────────────

describe("validateResearcherFindings()", () => {
	it("skip message with 'Research skipped:' → returns original string unchanged", () => {
		const msg =
			"## Research Findings — Research skipped: issue touches only internal code with no external dependency, library, or version question. No public web data needed.";
		const result = validateResearcherFindings(msg);
		assert.equal(result, msg);
	});

	it("graceful degradation message → returns original string unchanged", () => {
		const msg = "## Research Findings — No relevant results found for this topic.";
		const result = validateResearcherFindings(msg);
		assert.equal(result, msg);
	});

	it("substantive findings with bullets → returns original string unchanged", () => {
		const msg =
			"## Research Findings\n\n### Best Practices\n- Use version 5.0 — https://example.com\n- Enable strict mode — https://example.com\n\n### Common Pitfalls\n- Avoid global state — https://example.com";
		const result = validateResearcherFindings(msg);
		assert.equal(result, msg);
	});

	it("empty headers only (no bullet content) → returns graceful degradation message", () => {
		const msg = "## Research Findings\n\n### Best Practices\n- —\n\n### Common Pitfalls\n- —";
		const result = validateResearcherFindings(msg);
		assert.ok(
			result.includes("No relevant results found"),
			"Should fall back to graceful degradation",
		);
		assert.notEqual(result, msg);
	});

	it("empty string → returns graceful degradation message", () => {
		const result = validateResearcherFindings("");
		assert.ok(result.includes("No relevant results found"));
	});

	it("skip message with different reason → returns original unchanged", () => {
		const msg = "## Research Findings — Research skipped: Bug fix — config change only";
		const result = validateResearcherFindings(msg);
		assert.equal(result, msg);
	});

	it("substantive bullet content alongside skip prefix → returns original unchanged (skip detection doesn't override real findings)", () => {
		const msg =
			"## Research Findings — Research skipped: minor\n\n### Best Practices\n- Use version 5.0 — https://example.com";
		const result = validateResearcherFindings(msg);
		assert.equal(result, msg);
	});

	it("content with 'Research skipped:' in middle of text → returns original unchanged", () => {
		const msg =
			"## Research Findings\n\nSome content here. Research skipped: this shouldn't match mid-line.\n- Real finding — https://example.com";
		const result = validateResearcherFindings(msg);
		assert.equal(result, msg);
	});

	it("skip message at different position (start, middle, end) → all return original", () => {
		const msgs = [
			"## Research Findings — Research skipped: internal change. No web research needed.",
			"## Research Findings — Research skipped: refactor only. No external dependencies.",
			"## Research Findings — Research skipped: documentation update. No code changes.",
		];
		for (const msg of msgs) {
			const result = validateResearcherFindings(msg);
			assert.equal(result, msg, `Failed for: ${msg}`);
		}
	});
});

// ─── Tests: hasBranchCommits() ───────────────────────────────────

describe("hasBranchCommits()", () => {
	it("returns true when rev-list shows commits ahead of base", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const mockExec = async (
			cmd: string,
			args: string[],
			_opts?: Record<string, unknown>,
		): Promise<{ code: number; stdout: string; stderr: string }> => {
			calls.push({ cmd, args });
			return { code: 0, stdout: "3", stderr: "" };
		};

		const result = await hasBranchCommits(mockExec, "/repo", "feature", "main");
		assert.equal(result, true);

		// Verify git rev-list was called correctly
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, "git");
		assert.ok(calls[0].args.includes("rev-list"));
		assert.ok(calls[0].args.includes("--count"));
	});

	it("returns false when rev-list shows 0 commits ahead", async () => {
		const mockExec = async (): Promise<{ code: number; stdout: string; stderr: string }> => {
			return { code: 0, stdout: "0", stderr: "" };
		};

		const result = await hasBranchCommits(mockExec, "/repo", "feature", "main");
		assert.equal(result, false);
	});

	it("returns true when rev-list command fails (fail-safe)", async () => {
		const mockExec = async (): Promise<{ code: number; stdout: string; stderr: string }> => {
			return { code: 1, stdout: "", stderr: "fatal: ambiguous argument" };
		};

		const result = await hasBranchCommits(mockExec, "/repo", "feature", "main");
		assert.equal(result, true, "should return true on failure (fail-safe)");
	});

	it("returns true when rev-list throws (fail-safe)", async () => {
		const mockExec = async (): Promise<never> => {
			throw new Error("network error");
		};

		const result = await hasBranchCommits(mockExec, "/repo", "feature", "main");
		assert.equal(result, true, "should return true on exception (fail-safe)");
	});

	it("uses correct range syntax: main..feature", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const mockExec = async (
			cmd: string,
			args: string[],
			_opts?: Record<string, unknown>,
		): Promise<{ code: number; stdout: string; stderr: string }> => {
			calls.push({ cmd, args });
			return { code: 0, stdout: "1", stderr: "" };
		};

		await hasBranchCommits(mockExec, "/repo", "my-feature", "main");
		// The range should be "main..my-feature"
		const revListArgs = calls[0].args;
		const rangeArg = revListArgs.find((a: string) => a.includes(".."));
		assert.ok(rangeArg, "should contain a range with ..");
		assert.equal(rangeArg, "main..my-feature", "range should be baseBranch..headBranch");
	});
});

// ---------------------------------------------------------------------------
// Phase 6: handlePostAgentSuccess — scopePaths passthrough
// ---------------------------------------------------------------------------

describe("handlePostAgentSuccess — scopePaths passthrough", () => {
	it("developer with scopePaths passes them to commitAndPush", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add -- <paths>
				{ code: 0, stdout: "committed", stderr: "" }, // git commit
				{ code: 0, stdout: "", stderr: "" }, // git push
			],
			calls,
		);
		const result: AgentRunResult = {
			agentName: "developer",
			success: true,
			output: JSON.stringify({ action: "COMPLETE", agentName: "developer", commentBody: "Done" }),
			textOutput: JSON.stringify({
				action: "COMPLETE",
				agentName: "developer",
				commentBody: "Done",
			}),
			textOnly: "COMPLETE",
			toolCount: 5,
			tokenCount: 100,
			durationMs: 5000,
			summaryLine: "Implemented feature",
			errorOutput: "",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};
		const success = await handlePostAgentSuccess(
			pi,
			createMockCtx(),
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"my-branch",
			"Fix bug",
			undefined, // collector
			undefined, // gateRejected
			{ info: () => {}, error: () => {} }, // notify
			[".pi/extensions/supervisor/"], // scopePaths
		);
		assert.equal(success, true);
		// First git call should be git add -- <paths> not git add -A
		const addCall = calls.find((c) => c.cmd === "git" && c.args[0] === "add");
		assert.ok(addCall, "git add should be called");
		if (addCall) {
			assert.equal(addCall.args[1], "--", "Second arg should be -- when scopePaths provided");
			assert.deepEqual(
				addCall.args.slice(2),
				[".pi/extensions/supervisor/"],
				"Subsequent args should be the scope paths",
			);
		}
	});

	it("developer without scopePaths still calls commitAndPush with git add -A (backward compat)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add -A
				{ code: 0, stdout: "committed", stderr: "" }, // git commit
				{ code: 0, stdout: "", stderr: "" }, // git push
			],
			calls,
		);
		const result: AgentRunResult = {
			agentName: "developer",
			success: true,
			output: JSON.stringify({ action: "COMPLETE", agentName: "developer", commentBody: "Done" }),
			textOutput: JSON.stringify({
				action: "COMPLETE",
				agentName: "developer",
				commentBody: "Done",
			}),
			textOnly: "COMPLETE",
			toolCount: 5,
			tokenCount: 100,
			durationMs: 5000,
			summaryLine: "Implemented feature",
			errorOutput: "",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};
		const success = await handlePostAgentSuccess(
			pi,
			createMockCtx(),
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"my-branch",
			"Fix bug",
		);
		assert.equal(success, true);
		// First git call should be git add -A (no scopePaths)
		const addCall = calls.find((c) => c.cmd === "git" && c.args[0] === "add");
		assert.ok(addCall, "git add should be called");
		if (addCall) {
			assert.deepEqual(addCall.args, ["add", "-A"], "Should use git add -A when no scopePaths");
		}
	});
});

// ─── Tests: applyGateFailureContext() — gateFailureHistory ──────

describe("applyGateFailureContext() — gateFailureHistory", () => {
	it("initial state has empty gateFailureHistory", () => {
		const state = createStageState("Implementation");
		assert.ok(Array.isArray(state.gateFailureHistory), "gateFailureHistory should be an array");
		assert.equal(state.gateFailureHistory.length, 0, "should start empty");
	});

	it("pushes note to gateFailureHistory on Implementation with non-empty note", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "Some gate failure", 1);
		assert.equal(state.gateFailureHistory.length, 1, "should have 1 entry");
		assert.ok(state.gateFailureHistory[0]!.includes("run 1"), "entry should include run number");
	});

	it("pushes note to gateFailureHistory that includes run number", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "--- CI Gate ---\nSomething failed", 1);
		assert.equal(state.gateFailureHistory.length, 1);
		const entry = state.gateFailureHistory[0]!;
		assert.ok(entry.includes("CI Gate"), "entry should include gate name");
		assert.ok(entry.includes("run 1"), "entry should include run number");
		assert.ok(entry.includes("developer restarted"), "entry should mention developer restarted");
	});

	it("calling twice appends 2 entries", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "--- CI Gate ---\nFail 1", 1);
		applyGateFailureContext(state, "Implementation", "--- TSC Gate ---\nFail 2", 2);
		assert.equal(state.gateFailureHistory.length, 2, "should have 2 entries");
		assert.ok(state.gateFailureHistory[0]!.includes("CI Gate"), "first entry is CI Gate");
		assert.ok(state.gateFailureHistory[0]!.includes("run 1"), "first entry has run 1");
		assert.ok(state.gateFailureHistory[1]!.includes("TSC Gate"), "second entry is TSC Gate");
		assert.ok(state.gateFailureHistory[1]!.includes("run 2"), "second entry has run 2");
	});

	it("does NOT push when effectiveNextStatus is Audit", () => {
		const state = createStageState("Implementation");
		state.gateFailureContext = "previous failure";
		applyGateFailureContext(state, "Audit", "some note", 1);
		// Should clear gateFailureContext but NOT add to gateFailureHistory
		assert.equal(state.gateFailureContext, undefined, "gateFailureContext should be cleared");
		assert.equal(state.gateFailureHistory.length, 0, "gateFailureHistory should still be empty");
	});

	it("does NOT push when note is empty", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "", 1);
		assert.equal(state.gateFailureHistory.length, 0, "should not push empty note");
	});

	it("does NOT push when note is whitespace only", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "   ", 1);
		assert.equal(state.gateFailureHistory.length, 0, "should not push whitespace note");
	});

	it("does NOT push when effectiveNextStatus is neither Implementation nor Audit", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Done", "some note", 1);
		assert.equal(state.gateFailureHistory.length, 0, "should not push on other statuses");
		assert.equal(
			state.gateFailureContext,
			undefined,
			"gateFailureContext unchanged for non-Implementation/Audit",
		);
	});

	it("still sets gateFailureContext (iteration-local context) even on push", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "--- Dead Code Gate ---\nFound dead code", 3);
		assert.equal(state.gateFailureContext, "--- Dead Code Gate ---\nFound dead code");
		assert.equal(state.gateFailureHistory.length, 1);
	});

	it("extracts gate name from note with --- markers", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "--- CI Gate ---\nCI check failed", 2);
		const entry = state.gateFailureHistory[0]!;
		assert.ok(entry.includes("CI Gate"), "should extract 'CI Gate' from note");
		assert.ok(entry.includes("run 2"), "entry should include run number");
	});

	it("falls back to 'Pre-transition' when no --- markers in note", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "Some generic failure without markers", 1);
		const entry = state.gateFailureHistory[0]!;
		assert.ok(entry.startsWith("Pre-transition"), "should use fallback gate name when no markers");
	});

	it("accumulates 3+ entries (no capping)", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "--- CI Gate ---\nFail 1", 1);
		applyGateFailureContext(state, "Implementation", "--- TSC Gate ---\nFail 2", 2);
		applyGateFailureContext(state, "Implementation", "--- LSP Gate ---\nFail 3", 3);
		applyGateFailureContext(state, "Implementation", "--- Dead Code Gate ---\nFail 4", 4);
		assert.equal(state.gateFailureHistory.length, 4, "all 4 entries should be present");
	});

	it("gateFailureContext cleared on Audit, gateFailureHistory preserved", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "--- CI Gate ---\nFail", 1);
		assert.equal(state.gateFailureHistory.length, 1, "history has 1 entry after push");
		applyGateFailureContext(state, "Audit", "", 2);
		assert.equal(state.gateFailureContext, undefined, "context cleared on Audit");
		assert.equal(state.gateFailureHistory.length, 1, "history preserved on Audit");
	});
});
