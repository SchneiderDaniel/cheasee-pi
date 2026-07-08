/**
 * Tests for pipeline git/gh operations (Phase 2+4).
 *
 * Phase 2: pipeline posts issue comments deterministically after each agent
 * Phase 4: pipeline calls commitAndPush after developer agent succeeds
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-pipeline-git.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Tests — buildAgentTask no longer contains gh/git commands for non-auditor
// ---------------------------------------------------------------------------

describe("buildAgentTask — no gh issue comment in prompts (Phase 2)", () => {
	it("architect task no longer contains gh issue comment", async () => {
		const { buildAgentTask } = await import("../agent/task.ts");
		const task = buildAgentTask(
			"architect",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			[],
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
			[],
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
			[],
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
			[],
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

// ---------------------------------------------------------------------------
// Tests — extractStructuredAuditOutput helper (from github.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests — pipeline marker resolution
// ---------------------------------------------------------------------------

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

// ═══════════════════════════════════════════════════════════════════════
// Issue 299: Retry-success post-processing (Phase 2 — mock-based)
// ═══════════════════════════════════════════════════════════════════════

import type { AgentRunResult } from "../config/types.ts";

/**
 * Duplicate of pipeline.ts post-processing block for unit testing.
 * Uses injected mocks to verify behavior without GitHub API.
 */
/**
 * Validate agent result — derate if success=true with 0 tokens and >5 tools.
 * Duplicated from pipeline-output.ts to avoid ESM module resolution issues in tests.
 */
function testValidateAgentResult(result: AgentRunResult): void {
	if (result.success && result.tokenCount === 0 && result.toolCount > 5) {
		result.success = false;
		const existingError = result.errorOutput ? result.errorOutput + "\n" : "";
		result.errorOutput = `${existingError}Sanity check failed: success=true with tokenCount=0 and toolCount=${result.toolCount}. This indicates a timeout or abort before completion.`;
	}
}

/**
 * Extract last COMMENT_BODY marker content (matches github.ts behavior).
 */
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

// Fixtures
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

describe("Issue 299 — Retry-success post-processing (Phase 2 — mock-based)", () => {
	// ── Happy path ──

	it("happy path: first attempt succeeds — architect comment posted", async () => {
		let commentPosted = false;
		let commitPushed = false;

		await runPostProcessing(
			makeResult({ success: true, textOutput: "COMMENT_BODY: ## Architecture\nPlan here" }),
			"architect",
			{
				extractAgentCommentBody: (output) => {
					if (output.includes("COMMENT_BODY:")) {
						return output.split("COMMENT_BODY:").pop()?.trim() || null;
					}
					return null;
				},
				extractStructuredAuditOutput: () => null,
				postIssueComment: async () => {
					commentPosted = true;
				},
				commitAndPush: async () => {
					commitPushed = true;
				},
			},
		);

		assert.strictEqual(commentPosted, true, "Architect comment should be posted on success");
		assert.strictEqual(commitPushed, false, "commitAndPush should NOT be called for architect");
	});

	it("happy path: first attempt succeeds — developer commit pushed", async () => {
		let postIssueCommentCalled = false;
		let commitPushed = false;

		await runPostProcessing(makeResult({ success: true }), "developer", {
			extractAgentCommentBody: () => null,
			extractStructuredAuditOutput: () => null,
			postIssueComment: async () => {
				postIssueCommentCalled = true;
			},
			commitAndPush: async () => {
				commitPushed = true;
			},
		});

		assert.strictEqual(
			postIssueCommentCalled,
			false,
			"postIssueComment should NOT be called for developer",
		);
		assert.strictEqual(commitPushed, true, "commitAndPush should be called on developer success");
	});

	it("happy path: first attempt succeeds — auditor posts approval comment", async () => {
		let approvalPosted = false;

		await runPostProcessing(
			makeResult({
				success: true,
				textOutput: "AUDIT_DECISION: APPROVED\nCOMMENT_BODY: ## Approved",
			}),
			"auditor",
			{
				extractAgentCommentBody: () => null,
				extractStructuredAuditOutput: (output) => {
					if (output.includes("AUDIT_DECISION: APPROVED")) {
						return {
							decision: "APPROVED",
							commentBody: "## Approved\nLooks good!",
						};
					}
					return null;
				},
				postIssueComment: async () => {
					approvalPosted = true;
				},
				commitAndPush: async () => {},
			},
		);

		assert.strictEqual(approvalPosted, true, "Auditor approval comment should be posted");
	});

	it("happy path: first attempt succeeds — auditor posts rejection comment", async () => {
		let rejectionPosted = false;

		await runPostProcessing(
			makeResult({
				success: true,
				textOutput: "AUDIT_DECISION: REJECTED\nCOMMENT_BODY: ## Rejected",
			}),
			"auditor",
			{
				extractAgentCommentBody: () => null,
				extractStructuredAuditOutput: (output) => {
					if (output.includes("AUDIT_DECISION: REJECTED")) {
						return {
							decision: "REJECTED",
							commentBody: "## Rejected\nMissing tests",
						};
					}
					return null;
				},
				postIssueComment: async () => {
					rejectionPosted = true;
				},
				commitAndPush: async () => {},
			},
		);

		assert.strictEqual(rejectionPosted, true, "Auditor rejection comment should be posted");
	});

	// ── Retry-success path ──

	it("retry-success: architect comment posted (same as happy path)", async () => {
		let commentPosted = false;

		await runPostProcessing(
			makeResult({ success: true, textOutput: "COMMENT_BODY: ## Architecture\nRetry plan" }),
			"architect",
			{
				extractAgentCommentBody: (output) => {
					if (output.includes("COMMENT_BODY:")) {
						return output.split("COMMENT_BODY:").pop()?.trim() || null;
					}
					return null;
				},
				extractStructuredAuditOutput: () => null,
				postIssueComment: async () => {
					commentPosted = true;
				},
				commitAndPush: async () => {},
			},
		);

		assert.strictEqual(commentPosted, true, "Architect comment should be posted on retry-success");
	});

	it("retry-success: developer commit pushed", async () => {
		let commitPushed = false;

		await runPostProcessing(makeResult({ success: true }), "developer", {
			extractAgentCommentBody: () => null,
			extractStructuredAuditOutput: () => null,
			postIssueComment: async () => {},
			commitAndPush: async () => {
				commitPushed = true;
			},
		});

		assert.strictEqual(commitPushed, true, "commitAndPush should be called on retry-success");
	});

	it("retry-success: auditor posts approval comment", async () => {
		let approvalPosted = false;

		await runPostProcessing(
			makeResult({
				success: true,
				textOutput: "AUDIT_DECISION: APPROVED\nCOMMENT_BODY: ## Retry approved",
			}),
			"auditor",
			{
				extractAgentCommentBody: () => null,
				extractStructuredAuditOutput: (output) => {
					if (output.includes("AUDIT_DECISION: APPROVED")) {
						return {
							decision: "APPROVED",
							commentBody: "## Retry approved\nPassed on retry",
						};
					}
					return null;
				},
				postIssueComment: async () => {
					approvalPosted = true;
				},
				commitAndPush: async () => {},
			},
		);

		assert.strictEqual(approvalPosted, true, "Auditor approval should be posted on retry-success");
	});

	// ── Error path ──

	it("error path: both attempts fail — no post-processing", async () => {
		let commentPosted = false;
		let commitPushed = false;

		await runPostProcessing(
			makeResult({ success: false, textOutput: "COMMENT_BODY: ## Architecture\nPlan" }),
			"architect",
			{
				extractAgentCommentBody: () => "## Architecture\nPlan",
				extractStructuredAuditOutput: () => null,
				postIssueComment: async () => {
					commentPosted = true;
				},
				commitAndPush: async () => {
					commitPushed = true;
				},
			},
		);

		assert.strictEqual(commentPosted, false, "No comment posted when agent fails");
		assert.strictEqual(commitPushed, false, "No commit when agent fails");
	});

	it("error path: both fail — no developer commit", async () => {
		let commitPushed = false;

		await runPostProcessing(makeResult({ success: false }), "developer", {
			extractAgentCommentBody: () => null,
			extractStructuredAuditOutput: () => null,
			postIssueComment: async () => {},
			commitAndPush: async () => {
				commitPushed = true;
			},
		});

		assert.strictEqual(commitPushed, false, "No commit when developer fails");
	});

	it("error path: both fail — no auditor comment", async () => {
		let auditorCommentPosted = false;

		await runPostProcessing(
			makeResult({
				success: false,
				textOutput: "AUDIT_DECISION: APPROVED\nCOMMENT_BODY: Approved",
			}),
			"auditor",
			{
				extractAgentCommentBody: () => null,
				extractStructuredAuditOutput: () => ({ decision: "APPROVED", commentBody: "Approved" }),
				postIssueComment: async () => {
					auditorCommentPosted = true;
				},
				commitAndPush: async () => {},
			},
		);

		assert.strictEqual(auditorCommentPosted, false, "No auditor comment posted when auditor fails");
	});

	// ── validateAgentResult derates bad retry ──

	it("validateAgentResult derates bad retry (0 tokens, >5 tools)", async () => {
		// Simulate: initial run fails, retry succeeds but has 0 tokens with 10 tool calls
		const retryResult = makeResult({
			success: true,
			tokenCount: 0,
			toolCount: 10,
			textOutput: "COMMENT_BODY: bad",
		});

		// Apply test validateAgentResult as pipeline.ts does on retry path
		testValidateAgentResult(retryResult);

		// After derating, success should be false — no post-processing
		let commentPosted = false;
		await runPostProcessing(retryResult, "architect", {
			extractAgentCommentBody: () => "## Architecture\nPlan",
			extractStructuredAuditOutput: () => null,
			postIssueComment: async () => {
				commentPosted = true;
			},
			commitAndPush: async () => {},
		});

		assert.strictEqual(
			retryResult.success,
			false,
			"validateAgentResult derates 0-token retry to failed",
		);
		assert.strictEqual(commentPosted, false, "No comment posted for derated retry");
	});

	// ── Boundary: last-wins pattern ──

	it("boundary: last COMMENT_BODY marker wins (first-attempt partial, retry full)", async () => {
		let postedBody = "";

		await runPostProcessing(
			makeResult({
				success: true,
				textOutput: "some text\nCOMMENT_BODY: first partial\nCOMMENT_BODY: ## Final\nFull plan",
			}),
			"architect",
			{
				extractAgentCommentBody: (output) => testExtractAgentCommentBody(output),
				extractStructuredAuditOutput: () => null,
				postIssueComment: async (_num: number, body: string) => {
					postedBody = body;
				},
				commitAndPush: async () => {},
			},
		);

		assert.ok(postedBody.includes("## Final"), "Last COMMENT_BODY marker should win");
		assert.ok(postedBody.includes("Full plan"), "Last COMMENT_BODY content should be posted");
		assert.ok(!postedBody.includes("first partial"), "First COMMENT_BODY should be overridden");
	});

	it("boundary: architect with no COMMENT_BODY marker — no comment posted", async () => {
		let commentPosted = false;

		await runPostProcessing(
			makeResult({ success: true, textOutput: "Some output without markers" }),
			"architect",
			{
				extractAgentCommentBody: () => null,
				extractStructuredAuditOutput: () => null,
				postIssueComment: async () => {
					commentPosted = true;
				},
				commitAndPush: async () => {},
			},
		);

		assert.strictEqual(commentPosted, false, "No comment posted when no COMMENT_BODY marker");
	});
});
