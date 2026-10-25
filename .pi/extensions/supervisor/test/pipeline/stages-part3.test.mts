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
	trackAuditScore,
	createStageState,
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
	it("researcher targetStatus Implementation cannot skip Architecture", () => {
		const agentOutput = JSON.stringify({
			action: "COMPLETE",
			agentName: "researcher",
			summary: "Research complete",
			targetStatus: "Implementation",
		});
		const result = calculateNextStatus("researcher", agentOutput, "");
		assert.equal(result.status, "Architecture");
	});

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
