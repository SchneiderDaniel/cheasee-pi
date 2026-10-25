import assert from "node:assert";

import { describe, it } from "node:test";

import type { AgentRunResult } from "../config/types.ts";

function testValidateAgentResult(result: AgentRunResult): void {
	if (result.success && result.tokenCount === 0 && result.toolCount > 5) {
		result.success = false;
		const existingError = result.errorOutput ? result.errorOutput + "\n" : "";
		result.errorOutput = `${existingError}Sanity check failed: success=true with tokenCount=0 and toolCount=${result.toolCount}. This indicates a timeout or abort before completion.`;
	}
}

function testExtractAgentCommentBody(output: string): string | null {
	const startMarker = /COMMENT_BODY\s*:\s*/g;
	let lastBody: string | null = null;
	let match;
	while ((match = startMarker.exec(output)) !== null) {
		const start = match.index + match[0].length;
		const endIdx = output.indexOf("COMMENT_BODY_END", start);
		const body = endIdx !== -1 ? output.slice(start, endIdx) : output.slice(start);
		lastBody = body.trim();
	}
	return lastBody;
}

async function runPostProcessing(
	result: AgentRunResult,
	agentName: string,
	mocks: {
		extractAgentCommentBody: (output: string) => string | null;
		extractStructuredAuditOutput: (
			output: string,
		) => { decision: string; commentBody?: string } | null;
		postIssueComment: (issueNum: number, comment: string) => Promise<void>;
		commitAndPush: (commitMsg: string) => Promise<void>;
	},
): Promise<void> {
	// Gate: only process if agent succeeded (matches pipeline.ts after issue 299 fix)
	if (!result.success) {
		return;
	}

	const agentOutput = result.textOutput || result.output || "";

	// Phase 2: Post COMMENT_BODY for architect/test-designer/researcher
	if (agentName === "architect" || agentName === "test-designer" || agentName === "researcher") {
		const commentBody = mocks.extractAgentCommentBody(agentOutput);
		if (commentBody) {
			try {
				await mocks.postIssueComment(42, commentBody);
			} catch {
				// Non-fatal — same as pipeline.ts
			}
		}
	}

	// Phase 4: Commit and push after developer agent succeeds
	if (agentName === "developer") {
		try {
			await mocks.commitAndPush("feat(#42): test");
		} catch {
			// Non-fatal — same as pipeline.ts
		}
	}

	// Phase 3: Process structured auditor output
	if (agentName === "auditor") {
		const auditOutput = mocks.extractStructuredAuditOutput(agentOutput);
		if (auditOutput) {
			if (auditOutput.decision === "APPROVED") {
				if (auditOutput.commentBody) {
					try {
						await mocks.postIssueComment(42, auditOutput.commentBody);
					} catch {
						// Non-fatal
					}
				}
			} else if (auditOutput.decision === "REJECTED") {
				if (auditOutput.commentBody) {
					try {
						await mocks.postIssueComment(42, auditOutput.commentBody);
					} catch {
						// Non-fatal
					}
				}
			}
		}
	}
}

const makeResult = (overrides: Partial<AgentRunResult> = {}): AgentRunResult => ({
	success: true,
	output: "",
	textOutput: "",
	agentName: "test",
	toolCount: 0,
	tokenCount: 0,
	durationMs: 0,
	summaryLine: "",
	errorOutput: "",
	textOnly: "",
	...overrides,
});

describe("buildAgentTask — no gh issue comment in prompts (Phase 2)", () => {
	it("architect task no longer contains gh issue comment", async () => {
		const { buildAgentTask } = await import("../agent/task.ts");
		const task = buildAgentTask(
			"architect",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(!task.includes("gh issue comment"), "Architect should not contain gh issue comment");
	});

	it("test-designer task no longer contains gh issue comment", async () => {
		const { buildAgentTask } = await import("../agent/task.ts");
		const task = buildAgentTask(
			"test-designer",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(
			!task.includes("gh issue comment"),
			"Test-designer should not contain gh issue comment",
		);
	});

	it("researcher task no longer contains gh issue comment", async () => {
		const { buildAgentTask } = await import("../agent/task.ts");
		const task = buildAgentTask(
			"researcher",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(!task.includes("gh issue comment"), "Researcher should not contain gh issue comment");
	});

	it("developer task no longer contains git add/commit/push", async () => {
		const { buildAgentTask } = await import("../agent/task.ts");
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(!task.includes("git add -A"), "Developer should not contain git add -A");
		assert.ok(!task.includes("git commit"), "Developer should not contain git commit");
		assert.ok(!task.includes("git push"), "Developer should not contain git push");
	});
});
describe("extractStructuredAuditOutput", () => {
	it("extracts AUDIT_DECISION from agent output", async () => {
		const { extractStructuredAuditOutput } = await import("../agent/output.ts");
		const output =
			"AUDIT_DECISION: APPROVED\nPR_TITLE: feat(#42): fix\nPR_BODY: desc\nCOMMENT_BODY: nice";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result);
		assert.strictEqual(result!.decision, "APPROVED");
	});

	it("returns null when no AUDIT_DECISION marker", async () => {
		const { extractStructuredAuditOutput } = await import("../agent/output.ts");
		const result = extractStructuredAuditOutput("no markers here");
		assert.strictEqual(result, null);
	});

	it("extracts PR_TITLE, PR_BODY, COMMENT_BODY", async () => {
		const { extractStructuredAuditOutput } = await import("../agent/output.ts");
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat(#42): add feature",
			"PR_BODY: ## Summary",
			"Change description here",
			"## Details",
			"- Item 1",
			"- Item 2",
			"COMMENT_BODY: ## Audit Approved",
			"Looks good!",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result);
		assert.strictEqual(result!.decision, "APPROVED");
		assert.strictEqual(result!.prTitle, "feat(#42): add feature");
		assert.strictEqual(
			result!.prBody,
			"## Summary\nChange description here\n## Details\n- Item 1\n- Item 2",
		);
		assert.strictEqual(result!.commentBody, "## Audit Approved\nLooks good!");
	});

	it("handles REJECTED decision without PR fields", async () => {
		const { extractStructuredAuditOutput } = await import("../agent/output.ts");
		const output = "AUDIT_DECISION: REJECTED\nCOMMENT_BODY: ## Audit Rejected\nMissing tests";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result);
		assert.strictEqual(result!.decision, "REJECTED");
		assert.strictEqual(result!.commentBody, "## Audit Rejected\nMissing tests");
	});

	it("last AUDIT_DECISION marker wins", async () => {
		const { extractStructuredAuditOutput } = await import("../agent/output.ts");
		const output =
			"AUDIT_DECISION: APPROVED\nPR_TITLE: first\nAUDIT_DECISION: REJECTED\nCOMMENT_BODY: nope";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result);
		assert.strictEqual(result!.decision, "REJECTED");
	});
});
describe("Pipeline marker resolution for structured auditor output", () => {
	it("AUDIT_APPROVED marker resolves to Done", async () => {
		const { resolveNextStatus } = await import("../config/workflow.ts");
		const auditStep = {
			status: "Audit",
			markerMap: { AUDIT_APPROVED: "Done", AUDIT_REJECTED: "Implementation" },
		};
		const result = resolveNextStatus(auditStep, "AUDIT_DECISION: APPROVED\nAUDIT_APPROVED");
		assert.strictEqual(result, "Done");
	});

	it("AUDIT_REJECTED marker resolves to Implementation", async () => {
		const { resolveNextStatus } = await import("../config/workflow.ts");
		const auditStep = {
			status: "Audit",
			markerMap: { AUDIT_APPROVED: "Done", AUDIT_REJECTED: "Implementation" },
		};
		const result = resolveNextStatus(auditStep, "AUDIT_DECISION: REJECTED\nAUDIT_REJECTED");
		assert.strictEqual(result, "Implementation");
	});
});
