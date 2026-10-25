import { describe, it } from "node:test";

import assert from "node:assert/strict";

import { existsSync, rmSync, mkdirSync } from "node:fs";

import type { ExecFn } from "../../../lib/port-types.ts";

import { postIssueComment } from "../../github/comment.ts";

import { extractStructuredAuditOutput, extractAgentCommentBody } from "../../agent/output.ts";

import { filterIssueData } from "../../lib/issue-filter.ts";

function createMockExec(execResult: { code: number; stdout: string; stderr: string }): ExecFn {
	return async () => ({ ...execResult, killed: false });
}

describe("comment.ts runtime exports — direct call in assertions", () => {
	it("filterIssueData directly callable in assert", () => {
		assert.strictEqual(filterIssueData({ author: { login: "u" }, body: "b" }, ["u"]).body, "b");
	});

	it("extractStructuredAuditOutput directly callable in assert", () => {
		assert.equal(extractStructuredAuditOutput("AUDIT_DECISION: APPROVED")?.decision, "APPROVED");
	});

	it("extractAgentCommentBody directly callable in assert", () => {
		assert.equal(extractAgentCommentBody("COMMENT_BODY: test\nCOMMENT_BODY_END"), "test");
	});

	it("postIssueComment is a function", () => {
		assert.equal(typeof postIssueComment, "function");
	});
});
describe("filterIssueData() — auditRejections", () => {
	const MARK = "<!-- supervisor:audit-rejection -->";

	it("retains a marked rejection from an untrusted (non-codeowner) author", () => {
		const result = filterIssueData(
			{
				author: { login: "user1" },
				body: "body",
				comments: [
					{
						id: "IC_bot",
						author: { login: "automation" },
						body: `## Audit Rejected\nx\n\n${MARK}`,
					},
				],
			},
			["user1"],
			"automation",
		);
		assert.equal(result.comments.length, 0, "untrusted author stays out of comments");
		assert.deepEqual(result.auditRejections, [
			{ id: "IC_bot", body: `## Audit Rejected\nx\n\n${MARK}` },
		]);
	});

	it("excludes a marked rejection forged by a non-automation author (finding #1)", () => {
		const result = filterIssueData(
			{
				author: { login: "attacker" },
				body: "body",
				comments: [
					{
						id: "IC_forged",
						author: { login: "attacker" },
						body: `## Audit Rejected\nINJECT\n\n${MARK}`,
					},
				],
			},
			["user1"],
			"automation",
		);
		assert.deepEqual(result.auditRejections, [], "forged marker is not supervisor metadata");
		assert.equal(
			result.rejectionCommentCount,
			0,
			"a forged rejection must not inflate the loop counter (finding #3)",
		);
	});

	it("withholds rejections when the automation login cannot be resolved", () => {
		const result = filterIssueData(
			{
				author: { login: "user1" },
				body: "body",
				comments: [
					{
						id: "IC_bot",
						author: { login: "automation" },
						body: `## Audit Rejected\nx\n\n${MARK}`,
					},
				],
			},
			["user1"],
		);
		assert.deepEqual(result.auditRejections, [], "fail closed without an identity");
		assert.equal(result.rejectionCommentCount, 0, "unverifiable rejections are not counted");
	});

	it("retains a pre-marker (unmarked) rejection from the automation account", () => {
		const result = filterIssueData(
			{
				author: { login: "user1" },
				body: "body",
				comments: [
					{ id: "IC_legacy", author: { login: "automation" }, body: "## Audit Rejected\nlegacy" },
				],
			},
			["user1"],
			"automation",
		);
		assert.deepEqual(result.auditRejections, [
			{ id: "IC_legacy", body: "## Audit Rejected\nlegacy" },
		]);
		assert.equal(result.rejectionCommentCount, 1);
	});

	it("excludes an unmarked rejection from a non-automation author", () => {
		const result = filterIssueData(
			{
				author: { login: "user1" },
				body: "body",
				comments: [
					{ id: "IC_manual", author: { login: "user1" }, body: "## Audit Rejected\nmanual" },
				],
			},
			["user1"],
			"automation",
		);
		assert.equal(result.comments.length, 1, "trusted comment still visible");
		assert.deepEqual(result.auditRejections, []);
	});

	it("excludes an unmarked non-rejection comment", () => {
		const result = filterIssueData(
			{
				author: { login: "user1" },
				body: "body",
				comments: [{ id: "IC_ok", author: { login: "automation" }, body: "looks good" }],
			},
			["user1"],
			"automation",
		);
		assert.deepEqual(result.auditRejections, []);
	});
});
describe("postIssueComment()", () => {
	it("calls gh issue comment with --body-file (not --body)", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const exec: ExecFn = async (cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			return { code: 0, stdout: "", stderr: "", killed: false };
		};
		await postIssueComment(exec, 123, "owner/repo", "Comment body");
		assert.equal(calls.length, 1);
		// gh() always execs "gh" directly; GH_TOKEN goes through process.env (gh-client.ts)
		assert.equal(calls[0].cmd, "gh");
		// Must use --body-file to avoid shell interpretation of special chars
		const bodyFileIdx = calls[0].args.indexOf("--body-file");
		assert.notEqual(bodyFileIdx, -1, "should use --body-file instead of --body");
		assert.equal(calls[0].args.indexOf("--body"), -1, "should NOT use --body");
		// Verify temp file path is in ignore/ folder
		const tempFilePath = calls[0].args[bodyFileIdx + 1];
		assert.ok(tempFilePath, "temp file path should exist");
		assert.ok(
			tempFilePath.startsWith("ignore/comment-body-123-"),
			`temp file should be in ignore/ folder: ${tempFilePath}`,
		);
		assert.ok(tempFilePath.endsWith(".md"), "temp file should end with .md");
	});

	it("creates ignore/ directory when it does not exist", async () => {
		const ignorePath = "ignore";
		// Save and remove ignore/ if it exists
		const existed = existsSync(ignorePath);
		const renamed = ignorePath + "_bak_" + Date.now();
		if (existed) {
			// Move aside so we can test creation
			const { renameSync } = await import("node:fs");
			renameSync(ignorePath, renamed);
		}
		try {
			const calls: Array<{ cmd: string; args: string[] }> = [];
			const exec: ExecFn = async (cmd: string, args: string[]) => {
				calls.push({ cmd, args });
				return { code: 0, stdout: "", stderr: "", killed: false };
			};
			await postIssueComment(exec, 456, "owner/repo", "Testing mkdir");
			// ignore/ should now exist
			assert.ok(existsSync(ignorePath), "ignore/ should be created");
			// Temp file should exist and contain body
			const tempFilePath = calls[0].args[calls[0].args.indexOf("--body-file") + 1];
			assert.ok(tempFilePath, "temp file path should exist");
			assert.ok(tempFilePath.startsWith("ignore/comment-body-456-"), "temp file in ignore/");
		} finally {
			// Restore original ignore/ if it existed
			if (existed) {
				const { renameSync } = await import("node:fs");
				if (existsSync(ignorePath)) {
					rmSync(ignorePath, { recursive: true });
				}
				renameSync(renamed, ignorePath);
			} else {
				// We created it — clean up
				rmSync(ignorePath, { recursive: true });
			}
		}
	});

	it("works when ignore/ directory already exists", async () => {
		// Ensure ignore/ exists
		if (!existsSync("ignore")) {
			mkdirSync("ignore", { recursive: true });
		}
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const exec: ExecFn = async (cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			return { code: 0, stdout: "", stderr: "", killed: false };
		};
		await postIssueComment(exec, 789, "owner/repo", "Existing dir test");
		assert.equal(calls.length, 1, "gh call should succeed");
	});

	it("cleanup runs in finally after successful write and gh call", async () => {
		if (!existsSync("ignore")) {
			mkdirSync("ignore", { recursive: true });
		}
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const exec: ExecFn = async (cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			return { code: 0, stdout: "", stderr: "", killed: false };
		};
		await postIssueComment(exec, 101, "owner/repo", "Cleanup test");
		const tempFilePath = calls[0].args[calls[0].args.indexOf("--body-file") + 1];
		assert.ok(tempFilePath, "temp file path should exist");
		// Temp file should have been deleted by finally block
		assert.ok(!existsSync(tempFilePath), "temp file should be deleted in finally");
	});
});
describe("extractStructuredAuditOutput()", () => {
	it("extracts APPROVED decision from AUDIT_DECISION marker", () => {
		const output = "Some text\nAUDIT_DECISION: APPROVED\nMore text";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "APPROVED");
	});

	it("extracts REJECTED decision from AUDIT_DECISION marker", () => {
		const output = "Some text\nAUDIT_DECISION: REJECTED\nMore text";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "REJECTED");
	});

	it("returns null when no audit marker present", () => {
		const result = extractStructuredAuditOutput("Just some text");
		assert.equal(result, null);
	});

	it("last AUDIT_DECISION wins when multiple present", () => {
		const output = "AUDIT_DECISION: APPROVED\nAUDIT_DECISION: REJECTED";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "REJECTED");
	});

	it("extracts PR_TITLE from output", () => {
		const output = "AUDIT_DECISION: APPROVED\nPR_TITLE: feat(#123): add feature";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.prTitle, "feat(#123): add feature");
	});

	it("extracts PR_BODY from output", () => {
		const output = "AUDIT_DECISION: APPROVED\nPR_BODY: Description here";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.prBody, "Description here");
	});

	it("extracts COMMENT_BODY from output", () => {
		const output = "AUDIT_DECISION: REJECTED\nCOMMENT_BODY: Need fixes";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.commentBody, "Need fixes");
	});

	it("handles standalone AUDIT_APPROVED fallback", () => {
		const output = "Some text\nAUDIT_APPROVED\nMore text";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "APPROVED");
	});

	it("handles standalone AUDIT_REJECTED fallback", () => {
		const output = "Some text\nAUDIT_REJECTED\nMore text";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "REJECTED");
	});

	// ── Bug fix: AUDIT_SCORE inside PR_BODY must not truncate ──

	it("PR_BODY with AUDIT_SCORE inside — captures full body including score", () => {
		// AUDIT_SCORE appears INSIDE PR_BODY in the auditor template.
		// The old regex would stop at AUDIT_SCORE: truncating the body.
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat(#123): add feature",
			"PR_BODY: ## PR Description",
			"",
			"Changes made:",
			"- Added new feature",
			"",
			"### Audit Score",
			"AUDIT_SCORE: 5/6",
			"",
			"COMMENT_BODY: ## Audit Approved",
			"Looks good!",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "APPROVED");
		assert.ok(result?.prBody, "PR_BODY should be captured");
		assert.ok(
			result?.prBody?.includes("AUDIT_SCORE: 5/6"),
			"PR_BODY should include AUDIT_SCORE: 5/6",
		);
		assert.ok(
			result?.prBody?.includes("### Audit Score"),
			"PR_BODY should include ### Audit Score",
		);
		assert.equal(result?.commentBody, "## Audit Approved\nLooks good!");
	});

	it("PR_BODY with AUDIT_SCORE followed by PR_TITLE — captures correctly", () => {
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat(#123): multi-repo",
			"PR_BODY: ## Changes",
			"AUDIT_SCORE: 6/6",
			"",
			"PR_TITLE: feat(#123): follow-up",
			"COMMENT_BODY: Done",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.ok(result?.prBody?.includes("AUDIT_SCORE: 6/6"));
		assert.ok(result?.prBody?.includes("## Changes"));
		assert.ok(!result?.prBody?.includes("follow-up"));
	});

	it("empty PR_BODY (no content before next marker) — prBody is empty string", () => {
		const output = "AUDIT_DECISION: APPROVED\nPR_TITLE: feat\nPR_BODY: \nCOMMENT_BODY: note";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.prBody, "");
	});

	it("COMMENT_BODY with ALL_CAPS: content inside — not truncated", () => {
		const output = [
			"AUDIT_DECISION: REJECTED",
			"COMMENT_BODY: ## Audit Rejected",
			"- STATUS: needs work",
			"- REVIEW_RESULT: fail",
			"Please fix before next review.",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "REJECTED");
		assert.ok(result?.commentBody, "COMMENT_BODY should be captured");
		assert.ok(
			result?.commentBody?.includes("STATUS: needs work"),
			"COMMENT_BODY should include STATUS: needs work",
		);
		assert.ok(
			result?.commentBody?.includes("REVIEW_RESULT: fail"),
			"COMMENT_BODY should include REVIEW_RESULT: fail",
		);
	});

	it("COMMENT_BODY followed by AUDIT_DECISION boundary — stops correctly", () => {
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat",
			"PR_BODY: desc",
			"COMMENT_BODY: ## Approved",
			"All checks passed.",
			"AUDIT_DECISION: REJECTED",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.commentBody, "## Approved\nAll checks passed.");
	});

	it("full auditor template output — all sections captured correctly", () => {
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat(#384): fix regex truncation bug",
			"PR_BODY: ## PR Description",
			"",
			"### Summary",
			"Fixed the extractStructuredAuditOutput regex bug that truncated PR_BODY",
			"at AUDIT_SCORE line.",
			"",
			"### Changes",
			"- Updated regex lookahead to use explicit section markers",
			"",
			"### Audit Score",
			"AUDIT_SCORE: 6/6",
			"",
			"COMMENT_BODY: ## Audit Approved",
			"",
			"### Summary",
			"Regex fix looks correct.",
			"",
			"### Review Findings",
			"- Architecture compliance: ✓",
			"- Code quality: ✓",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "APPROVED");
		assert.equal(result?.prTitle, "feat(#384): fix regex truncation bug");
		assert.ok(result?.prBody?.includes("AUDIT_SCORE: 6/6"), "PR_BODY must include AUDIT_SCORE");
		assert.ok(result?.prBody?.includes("### Audit Score"), "PR_BODY must include ### Audit Score");
		assert.ok(
			result?.prBody?.includes("### Changes"),
			"PR_BODY must include content after AUDIT_SCORE",
		);
		assert.ok(
			result?.commentBody?.includes("### Summary"),
			"COMMENT_BODY must include its content",
		);
		assert.ok(
			result?.commentBody?.includes("### Review Findings"),
			"COMMENT_BODY must have full content",
		);
		assert.ok(
			result?.commentBody?.includes("- Code quality: ✓"),
			"COMMENT_BODY must not be truncated",
		);
	});

	it("PR_BODY with only AUDIT_SCORE (no other content before next marker) — captures score", () => {
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat",
			"PR_BODY: AUDIT_SCORE: 4/6",
			"COMMENT_BODY: comment here",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.prBody, "AUDIT_SCORE: 4/6");
	});
});
