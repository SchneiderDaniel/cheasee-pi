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
	type StageState,
	type AuditGateContext,
	type GateRejected,
	buildApprovalCommentFromOutput,
	buildRejectionCommentFromOutput,
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

describe("buildApprovalCommentFromOutput()", () => {
	it("full output (score + findings) — contains all sections", () => {
		const input = wrapJsonOutput({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: 4, total: 7 },
			findings: [
				{
					severity: "suggestion",
					dimension: "code-quality",
					symptom: "Minor lint issue",
					consequence: "Readability",
					remedy: "Fix lint",
					location: "src/index.ts",
				},
			],
		});
		const result = buildApprovalCommentFromOutput(input);
		assert.ok(result, "should return a comment string");
		assert.ok(result.includes("## Audit Approved"), "should have approval title");
		assert.ok(result.includes("**Score:** 4/7 — 4 of 7 dimensions passing"), "should have score");
		assert.ok(result.includes("### Findings"), "should have findings section");
		assert.ok(result.includes("suggestion — code-quality"), "should have finding heading");
		assert.ok(result.includes("Symptom: Minor lint issue"), "should have symptom");
		assert.ok(result.includes("Consequence: Readability"), "should have consequence");
		assert.ok(result.includes("Remedy: Fix lint"), "should have remedy");
		assert.ok(result.includes("Location: src/index.ts"), "should have location");
		assert.ok(
			result.endsWith("Fix and resubmit if issues remain."),
			"should end with approval footer",
		);
	});

	it("returns null for unparseable input (empty string)", () => {
		assert.equal(buildApprovalCommentFromOutput(""), null);
	});

	it("returns null for whitespace-only input", () => {
		assert.equal(buildApprovalCommentFromOutput("   "), null);
	});

	it("returns null for garbage input", () => {
		assert.equal(buildApprovalCommentFromOutput("not valid json at all"), null);
	});

	it("score only, no findings — has score block, no findings section, correct footer", () => {
		const input = wrapJsonOutput({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: 3, total: 5 },
		});
		const result = buildApprovalCommentFromOutput(input);
		assert.ok(result);
		assert.ok(result.includes("## Audit Approved"), "should have approval title");
		assert.ok(result.includes("**Score:** 3/5"), "should have score");
		assert.ok(!result.includes("### Findings"), "should NOT have findings section");
		assert.ok(
			result.endsWith("Fix and resubmit if issues remain."),
			"should end with approval footer",
		);
	});

	it("findings only, no score — no score block, has findings section, correct footer", () => {
		const input = wrapJsonOutput({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "critical",
					dimension: "test-quality",
					symptom: "No tests",
					consequence: "Bugs",
					remedy: "Add tests",
				},
			],
		});
		const result = buildApprovalCommentFromOutput(input);
		assert.ok(result);
		assert.ok(result.includes("## Audit Approved"), "should have approval title");
		assert.ok(!result.includes("**Score:"), "should NOT have score block");
		assert.ok(result.includes("### Findings"), "should have findings section");
		assert.ok(
			result.endsWith("Fix and resubmit if issues remain."),
			"should end with approval footer",
		);
	});

	it("empty findings array — no findings section rendered", () => {
		const input = wrapJsonOutput({
			action: "APPROVED",
			agentName: "auditor",
			findings: [],
		});
		const result = buildApprovalCommentFromOutput(input);
		assert.ok(result);
		assert.ok(result.includes("## Audit Approved"), "should have approval title");
		assert.ok(!result.includes("### Findings"), "should NOT have findings section");
	});

	it("score passing=0 displays 0/total", () => {
		const input = wrapJsonOutput({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: 0, total: 5 },
		});
		const result = buildApprovalCommentFromOutput(input);
		assert.ok(result);
		assert.ok(
			result.includes("**Score:** 0/5 — 0 of 5 dimensions passing"),
			"should show 0 passing",
		);
	});

	it("score passing=total displays 'All dimensions passing'", () => {
		const input = wrapJsonOutput({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: 7, total: 7 },
		});
		const result = buildApprovalCommentFromOutput(input);
		assert.ok(result);
		assert.ok(result.includes("All dimensions passing"), "should show all passing");
	});

	it("score mid-value displays X of Y dimensions passing", () => {
		const input = wrapJsonOutput({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: 3, total: 7 },
		});
		const result = buildApprovalCommentFromOutput(input);
		assert.ok(result);
		assert.ok(result.includes("3 of 7 dimensions passing"), "should show mid value");
	});

	it("findings with minimum fields (severity + dimension + required fields only) — no optional location line", () => {
		const input = wrapJsonOutput({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "warning",
					dimension: "architecture-compliance",
					symptom: "Bad design",
					consequence: "Hard to maintain",
					remedy: "Refactor",
				},
			],
		});
		const result = buildApprovalCommentFromOutput(input);
		assert.ok(result);
		assert.ok(result.includes("warning — architecture-compliance"), "should have finding heading");
		assert.ok(result.includes("Symptom: Bad design"), "should have symptom");
		assert.ok(result.includes("Consequence: Hard to maintain"), "should have consequence");
		assert.ok(result.includes("Remedy: Refactor"), "should have remedy");
		assert.ok(!result.includes("Location:"), "should NOT have location line");
	});

	it("findings with all optional fields — all sub-lines present", () => {
		const input = wrapJsonOutput({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "critical",
					dimension: "correctness-safety",
					symptom: "Null pointer",
					consequence: "Crash",
					remedy: "Add null check",
					location: "src/utils.ts:42",
				},
			],
		});
		const result = buildApprovalCommentFromOutput(input);
		assert.ok(result);
		assert.ok(result.includes("Symptom: Null pointer"), "should have symptom");
		assert.ok(result.includes("Consequence: Crash"), "should have consequence");
		assert.ok(result.includes("Remedy: Add null check"), "should have remedy");
		assert.ok(result.includes("Location: src/utils.ts:42"), "should have location");
	});

	it("multiple findings — each renders as a bullet, order preserved", () => {
		const input = wrapJsonOutput({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "critical",
					dimension: "architecture-compliance",
					symptom: "First",
					consequence: "Bad",
					remedy: "Fix",
				},
				{
					severity: "warning",
					dimension: "test-quality",
					symptom: "Second",
					consequence: "Bad",
					remedy: "Fix",
				},
				{
					severity: "suggestion",
					dimension: "code-quality",
					symptom: "Third",
					consequence: "Bad",
					remedy: "Fix",
				},
			],
		});
		const result = buildApprovalCommentFromOutput(input);
		assert.ok(result);
		const firstIdx = result.indexOf("critical — architecture-compliance");
		const secondIdx = result.indexOf("warning — test-quality");
		const thirdIdx = result.indexOf("suggestion — code-quality");
		assert.ok(firstIdx >= 0, "first finding present");
		assert.ok(secondIdx > firstIdx, "second finding after first");
		assert.ok(thirdIdx > secondIdx, "third finding after second");
	});
});
describe("buildRejectionCommentFromOutput()", () => {
	it("full output (score + findings) — contains all sections", () => {
		const input = wrapJsonOutput({
			action: "REJECTED",
			agentName: "auditor",
			auditScore: { passing: 2, total: 7 },
			findings: [
				{
					severity: "critical",
					dimension: "ticket-fulfillment",
					symptom: "Missing scope",
					consequence: "Incomplete",
					remedy: "Add scope",
				},
			],
		});
		const result = buildRejectionCommentFromOutput(input);
		assert.ok(result, "should return a comment string");
		assert.ok(result.includes("## Audit Rejected"), "should have rejection title");
		assert.ok(result.includes("**Score:** 2/7 — 2 of 7 dimensions passing"), "should have score");
		assert.ok(result.includes("### Findings"), "should have findings section");
		assert.ok(result.includes("critical — ticket-fulfillment"), "should have finding heading");
		assert.ok(result.includes("Symptom: Missing scope"), "should have symptom");
		assert.ok(result.includes("Consequence: Incomplete"), "should have consequence");
		assert.ok(result.includes("Remedy: Add scope"), "should have remedy");
		assert.ok(
			result.endsWith("Fix the issues above and resubmit."),
			"should end with rejection footer",
		);
	});

	it("returns null for unparseable input (empty string)", () => {
		assert.equal(buildRejectionCommentFromOutput(""), null);
	});

	it("returns null for whitespace-only input", () => {
		assert.equal(buildRejectionCommentFromOutput("   "), null);
	});

	it("returns null for garbage input", () => {
		assert.equal(buildRejectionCommentFromOutput("not valid json at all"), null);
	});

	it("score only, no findings — has score block, no findings section, correct footer", () => {
		const input = wrapJsonOutput({
			action: "REJECTED",
			agentName: "auditor",
			auditScore: { passing: 1, total: 5 },
		});
		const result = buildRejectionCommentFromOutput(input);
		assert.ok(result);
		assert.ok(result.includes("## Audit Rejected"), "should have rejection title");
		assert.ok(result.includes("**Score:** 1/5"), "should have score");
		assert.ok(!result.includes("### Findings"), "should NOT have findings section");
		assert.ok(
			result.endsWith("Fix the issues above and resubmit."),
			"should end with rejection footer",
		);
	});

	it("findings only, no score — no score block, has findings section, correct footer", () => {
		const input = wrapJsonOutput({
			action: "REJECTED",
			agentName: "auditor",
			findings: [
				{
					severity: "warning",
					dimension: "completeness",
					symptom: "Missing section",
					consequence: "Incomplete",
					remedy: "Add section",
				},
			],
		});
		const result = buildRejectionCommentFromOutput(input);
		assert.ok(result);
		assert.ok(result.includes("## Audit Rejected"), "should have rejection title");
		assert.ok(!result.includes("**Score:"), "should NOT have score block");
		assert.ok(result.includes("### Findings"), "should have findings section");
		assert.ok(
			result.endsWith("Fix the issues above and resubmit."),
			"should end with rejection footer",
		);
	});

	it("empty findings array — no findings section rendered", () => {
		const input = wrapJsonOutput({
			action: "REJECTED",
			agentName: "auditor",
			findings: [],
		});
		const result = buildRejectionCommentFromOutput(input);
		assert.ok(result);
		assert.ok(result.includes("## Audit Rejected"), "should have rejection title");
		assert.ok(!result.includes("### Findings"), "should NOT have findings section");
	});

	it("multiple findings — order preserved", () => {
		const input = wrapJsonOutput({
			action: "REJECTED",
			agentName: "auditor",
			findings: [
				{
					severity: "critical",
					dimension: "architecture-compliance",
					symptom: "First",
					consequence: "Bad",
					remedy: "Fix",
				},
				{
					severity: "warning",
					dimension: "test-quality",
					symptom: "Second",
					consequence: "Bad",
					remedy: "Fix",
				},
			],
		});
		const result = buildRejectionCommentFromOutput(input);
		assert.ok(result);
		const firstIdx = result.indexOf("critical — architecture-compliance");
		const secondIdx = result.indexOf("warning — test-quality");
		assert.ok(firstIdx >= 0, "first finding present");
		assert.ok(secondIdx > firstIdx, "second finding after first");
	});
});
